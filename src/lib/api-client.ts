"use client";

/** Client-side fetch helper with JSON + error normalization. */

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export async function apiFetch<T = unknown>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.error ?? "Something went wrong. Please try again.";
    throw new ApiError(res.status, message, data?.code);
  }
  return data as T;
}

export const api = {
  get: <T = unknown>(url: string) => apiFetch<T>(url),
  post: <T = unknown>(url: string, body?: unknown) =>
    apiFetch<T>(url, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T = unknown>(url: string, body?: unknown) =>
    apiFetch<T>(url, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
};
