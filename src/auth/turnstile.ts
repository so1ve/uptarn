import type { Context } from "hono";

import type { TurnstileConfig } from "../config.ts";
import { httpError } from "../http.ts";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2048;

interface SiteverifyResponse {
  success?: boolean;
  action?: string;
  hostname?: string;
}

function extractClientIp(c: Context): string | null {
  const cfIp = c.req.header("CF-Connecting-IP")?.trim();
  if (cfIp) {
    return cfIp;
  }
  const forwarded = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim();

  return forwarded || null;
}

export async function verifyTurnstileToken(
  c: Context,
  turnstile: TurnstileConfig,
  fallbackHostname: string,
  token: unknown,
  expectedAction: string,
): Promise<void> {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    throw httpError(403, "Verification required");
  }

  const params = new URLSearchParams({
    secret: turnstile.secret,
    response: token,
  });
  const remoteip = extractClientIp(c);
  if (remoteip) {
    params.set("remoteip", remoteip);
  }

  let result: SiteverifyResponse;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: params,
    });
    if (!response.ok) {
      throw new Error(`siteverify HTTP ${response.status}`);
    }
    result = await response.json<SiteverifyResponse>();
  } catch {
    throw httpError(403, "Verification failed, try again");
  }

  const hostname = result.hostname?.toLowerCase();
  const hostnameAllowed =
    hostname !== undefined &&
    (turnstile.hostnames.length > 0
      ? turnstile.hostnames.includes(hostname)
      : hostname === fallbackHostname.toLowerCase());

  if (
    result.success !== true ||
    result.action !== expectedAction ||
    !hostnameAllowed
  ) {
    throw httpError(403, "Verification failed, try again");
  }
}
