/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 设为 '1' 时，构建产物会暴露测试钩子（`window.__dshReaderSession`）。
   * 仅用于自动化验证——默认构建里这段代码会被摇掉。
   */
  readonly VITE_EXPOSE_TEST_HOOKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
