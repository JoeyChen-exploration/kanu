// 调 /api 的封装：只请求同源相对路径（C-1），自动带会话。写操作的幂等 key 等 M2 有写接口时再加。
import type { ApiError } from '@kanu/shared/types';

let session: string | null = null;
export const setSession = (s: string) => { session = s; };

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session ? { authorization: `Bearer ${session}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok === false) {
    const err = (data ?? {}) as Partial<ApiError>;
    throw new ApiFailure(res.status, err.code ?? 'network', err.message ?? '网络出错了，稍后再试');
  }
  return data as T;
}
