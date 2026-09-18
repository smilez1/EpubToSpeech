import type {
  BookListResponse,
  BookMeta,
  BookMetaPatch,
  ProgressPatch,
  UploadBookResponse,
} from '@shared/book.ts';
import { isApiErrorBody } from '@shared/book.ts';

/** 带后端错误码的异常，便于 UI 区分处理。 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(0, 'NETWORK', `无法连接本地服务：${(err as Error).message}`);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!res.ok) {
    const code = isApiErrorBody(parsed) ? parsed.error.code : 'HTTP_ERROR';
    const message = isApiErrorBody(parsed)
      ? parsed.error.message
      : `请求失败 (HTTP ${res.status}) ${text.slice(0, 200)}`;
    throw new ApiError(res.status, code, message);
  }
  return parsed as T;
}

export const api = {
  async health(): Promise<{ ok: boolean; version: string }> {
    return request('/api/health');
  },

  async listBooks(): Promise<BookMeta[]> {
    const data = await request<BookListResponse>('/api/books');
    return data.books;
  },

  async uploadBook(file: File, cover?: Blob): Promise<UploadBookResponse> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (cover) form.append('cover', cover, 'cover.img');
    return request<UploadBookResponse>('/api/books', { method: 'POST', body: form });
  },

  async updateMeta(id: string, patch: BookMetaPatch): Promise<BookMeta> {
    const data = await request<{ book: BookMeta }>(`/api/books/${id}/meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return data.book;
  },

  async saveProgress(id: string, patch: ProgressPatch): Promise<BookMeta> {
    const data = await request<{ book: BookMeta }>(`/api/books/${id}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return data.book;
  },

  async deleteBook(id: string): Promise<void> {
    await request<void>(`/api/books/${id}`, { method: 'DELETE' });
  },

  bookFileUrl(id: string): string {
    return `/api/books/${id}/file`;
  },

  coverUrl(id: string, updatedAt: number): string {
    // 带上 updatedAt 作为版本号，封面更新后立即失效缓存
    return `/api/books/${id}/cover?v=${updatedAt}`;
  },
};
