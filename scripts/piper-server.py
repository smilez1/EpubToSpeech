"""Piper 本地 CPU TTS sidecar（使用 piper-tts Python API，模型常驻内存）。

启动：
    pnpm piper:server
环境变量：
    PIPER_HOST        监听地址（默认 127.0.0.1）
    PIPER_PORT        监听端口（默认 8788）
    PIPER_MODEL_DIR   模型目录（默认 <项目根>/models/piper）
接口：
    GET  /health                       服务状态与已加载音色
    GET  /voices                       可用音色列表
    POST /synthesize                   {"text","voice","rate"} -> WAV
    POST /provider                     切换默认音色 {"voice"}
"""

from __future__ import annotations

import io
import json
import os
import pathlib
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 强制 transformers / huggingface_hub 走本地缓存，不要联网验证。
# g2pW 的 BertTokenizer 每次 from_pretrained 都会尝试访问 huggingface.co，
# 网络不通时会在持锁状态下长时间阻塞（表现为"没有声音 + 服务卡死"）。
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODEL_DIR = pathlib.Path(os.getenv("PIPER_MODEL_DIR", str(ROOT / "models" / "piper")))
# g2pW 查表与 g2pw.onnx 资源目录（chaowen/xiao_ya 中文模型需要）。
RESOURCE_DIR = MODEL_DIR / "_resources"
HOST = os.getenv("PIPER_HOST", "127.0.0.1")
PORT = int(os.getenv("PIPER_PORT", "8788"))

_LOAD_LOCK = threading.Lock()  # 只保护「模型加载/切换」，不串行化合成
_SYNTH_LOCK = threading.Lock()  # 串行化合成：onnxruntime 并发 run 有线程争用，实测并发反而更慢
_VOICE: object | None = None          # 当前 PiperVoice 实例
_VOICE_NAME: str = ""                 # 当前音色文件名（不含 .onnx）
_LOAD_ERROR: str | None = None


def list_models() -> list[str]:
    """models/piper 下的 *.onnx（排除 _resources）。"""
    if not MODEL_DIR.is_dir():
        return []
    return sorted(p.stem for p in MODEL_DIR.glob("*.onnx"))


def _resolve_name(voice: str | None) -> str:
    """把请求里的音色名解析成 models/piper 里的实际文件名前缀。

    前端未指定音色时会传 'default'（旧前端）或空——这些都意味着"用当前音色"，
    绝不能把它们当成新音色去触发模型重载（重载要 7~15s，会堵住所有合成）。
    """
    models = list_models()
    if not models:
        raise FileNotFoundError("models/piper 下没有 .onnx 模型，请先放入 Piper 中文模型")
    if voice and voice != "default" and voice in models:
        return voice
    return _VOICE_NAME if _VOICE_NAME in models else models[0]


def _load(voice: str | None = None) -> object:
    """加载（或切换）音色。返回 PiperVoice 实例。"""
    global _VOICE, _VOICE_NAME, _LOAD_ERROR
    from piper import PiperVoice

    name = _resolve_name(voice)
    model_path = MODEL_DIR / f"{name}.onnx"
    # download_dir 里放 g2pW 资源（查表 + g2pw.onnx）。huayan 用 espeak 不需要，但无害。
    _VOICE = PiperVoice.load(str(model_path), download_dir=str(RESOURCE_DIR))
    _VOICE_NAME = name
    return _VOICE


def get_voice(voice: str | None = None) -> object:
    """返回（或切换）当前音色。与请求的音色一致时复用已加载实例，避免重复加载。

    只在「模型加载/切换」持锁，合成本身不拿锁——这样前端 prefetch 的多个
    合成请求可以并行，不会因为前一句还在合成就把后续句子堵住。
    """
    global _VOICE, _LOAD_ERROR
    with _LOAD_LOCK:
        # 关键：用「解析后的音色名」判断是否需要重载。
        # 前端未选音色时会传 'default'/空，这些不应触发重载。
        want = _resolve_name(voice)
        if _VOICE is None or want != _VOICE_NAME:
            try:
                _load(want)
            except Exception as exc:  # noqa: BLE001
                _LOAD_ERROR = str(exc)
                raise
        return _VOICE


def synthesize(text: str, voice: str | None, rate: float,
               noise_scale: float | None = None, noise_w_scale: float | None = None) -> bytes:
    """合成整段文本为 WAV（16-bit PCM mono）。"""
    if not text or not text.strip():
        raise ValueError("text 不能为空")
    if len(text) > 2000:
        raise ValueError("text 过长，请先切句（<=2000 字符）")

    # 合成在 _SYNTH_LOCK 内串行执行：onnxruntime 多个线程同时 run 同一个 session
    # 会有线程争用，实测并发反而更慢。前端靠 prefetch 提前一句发起合成，
    # 串行每句约 1.4s，而播放一句通常 3~5s，提前量足够，不需要并发。
    with _SYNTH_LOCK:
        voice_obj = get_voice(voice)

        from piper import SynthesisConfig

        syn = SynthesisConfig(
            length_scale=max(0.25, min(4.0, 1.0 / max(0.1, rate))),
            noise_scale=noise_scale if noise_scale is not None else 0.667,
            noise_w_scale=noise_w_scale if noise_w_scale is not None else 0.8,
        )
        chunks = list(voice_obj.synthesize(text, syn_config=syn))

    if not chunks:
        raise ValueError("合成结果为空")

    sample_rate = chunks[0].sample_rate
    frames = bytearray()
    for chunk in chunks:
        frames.extend(chunk.audio_int16_bytes)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(bytes(frames))
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    server_version = "PiperSidecar/1.0"

    def log_message(self, _fmt: str, *_args: object) -> None:
        # 关闭默认请求日志，避免刷屏；错误单独打印。
        pass

    def _send_json(self, status: int, value: object) -> None:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 128 * 1024:
            raise ValueError("请求体过大")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self) -> None:  # noqa: N802
        # health / voices 不抢加载锁：首次模型加载可能耗时数秒，若在此联网
        # 更会卡住；health 应立即可读，避免前端"未连接"误判。
        if self.path == "/health":
            try:
                models = list_models()
                self._send_json(200, {
                    "ready": bool(models),
                    "models": models,
                    "loaded": _VOICE_NAME if _VOICE is not None else "",
                    "error": _LOAD_ERROR,
                    "cpu": True,
                })
            except Exception as exc:  # noqa: BLE001
                self._send_json(503, {"ready": False, "error": str(exc)})
            return
        if self.path == "/voices":
            models = list_models()
            self._send_json(200, {
                "voices": [
                    {"id": name, "name": name, "lang": "zh-CN", "local": True}
                    for name in models
                ],
            })
            return
        self._send_json(404, {"error": {"code": "NOT_FOUND", "message": "没有这个接口"}})

    def do_POST(self) -> None:  # noqa: N802
        try:
            body = self._read_body()
            if self.path == "/synthesize":
                wav = synthesize(
                    str(body.get("text", "")),
                    body.get("voice"),
                    float(body.get("rate", 1.0)),
                    float(body["noiseScale"]) if "noiseScale" in body else None,
                    float(body["noiseWScale"]) if "noiseWScale" in body else None,
                )
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/wav")
                    self.send_header("Content-Length", str(len(wav)))
                    self.end_headers()
                    self.wfile.write(wav)
                except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                    pass
                return
            if self.path == "/provider":
                with _LOAD_LOCK:
                    _load(str(body.get("voice", "")))
                self._send_json(200, {"ok": True, "voice": _VOICE_NAME})
                return
        except json.JSONDecodeError:
            self._send_json(400, {"error": {"code": "BAD_JSON", "message": "请求体不是合法 JSON"}})
            return
        except Exception as exc:  # noqa: BLE001
            self._send_json(400, {"error": {"code": "SYNTHESIS_FAILED", "message": str(exc)}})
            return
        self._send_json(404, {"error": {"code": "NOT_FOUND", "message": "没有这个接口"}})


def main() -> None:
    models = list_models()
    print(f"Piper sidecar: {len(models)} 个音色 -> {MODEL_DIR}")
    if models:
        print(f"可用音色: {', '.join(models)}")
        print("首次请求会加载默认音色（含 g2pW 中文查表），可能需要几秒。")

        def _warmup() -> None:
            """后台预热默认音色：用户第一次点播放时模型已就绪，不用再等加载。

            只加载 PiperVoice 不够——g2pW 查表（g2pw.onnx 152MB）与 BertTokenizer
            是首次 phonemize() 时才懒加载的，所以预热必须真正合成一个短句。
            """
            try:
                _load()
                _load_error = _LOAD_ERROR
                if not _load_error:
                    synthesize("预热。", None, 1.0)
                print(f"预热完成: {_VOICE_NAME}")
            except Exception as exc:  # noqa: BLE001
                _LOAD_ERROR = str(exc)
                print(f"预热失败: {exc}")

        threading.Thread(target=_warmup, daemon=True).start()
    else:
        print("警告: models/piper 下没有 .onnx 模型，请先放入 Piper 中文模型。")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Piper sidecar listening on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()