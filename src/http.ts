import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const httpError = (
  status: ContentfulStatusCode,
  message: string,
): HTTPException => new HTTPException(status, { message });

async function readTextWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) {
    throw httpError(400, "Invalid JSON body");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw httpError(413, "Request body too large");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return text + decoder.decode();
}

export async function readJson<T = unknown>(
  c: Context,
  maxBytes?: number,
): Promise<T> {
  if (maxBytes === undefined) {
    try {
      return await c.req.json<T>();
    } catch {
      throw httpError(400, "Invalid JSON body");
    }
  }
  const contentLength = Number(c.req.header("Content-Length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw httpError(413, "Request body too large");
  }
  const raw = await readTextWithLimit(c.req.raw.body, maxBytes);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
}

export function extractBearer(c: Context): string | null {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return null;
  }

  return header.slice(7).trim() || null;
}

export async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let remaining = maxBytes;
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      remaining -= value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return text + decoder.decode();
}
