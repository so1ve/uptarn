import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { LoadedConfig } from "../config.ts";
import type { SqlDatabase } from "../db/index.ts";
import { extractBearer, httpError, readJson } from "../http.ts";
import { unixNow } from "../shared/index.ts";
import { verifyCloudflareAccessJwt } from "./cf-access.ts";
import {
  generateRandomToken,
  sha256Hex,
  timingSafeEqualText,
} from "./crypto.ts";
import { verifyTurnstileToken } from "./turnstile.ts";

const SESSION_COOKIE = "uptarn_session";
const SESSION_TTL_SECS = 30 * 86_400;

export const hasPasswordLogin = (config: LoadedConfig): boolean =>
  Boolean(
    config.adminPassword ?? config.adminPasswordSha256 ?? config.adminToken,
  );

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function resolveRpOrigin(
  c: Context,
  config: LoadedConfig,
): { rpID: string; origin: string } {
  const reqUrl = new URL(c.req.url);
  if (!LOOPBACK_HOSTS.has(reqUrl.hostname)) {
    const forwardedProto = c.req
      .header("X-Forwarded-Proto")
      ?.split(",")[0]
      ?.trim()
      .toLowerCase();
    const origin =
      reqUrl.protocol === "http:" && forwardedProto === "https"
        ? `https://${reqUrl.host}`
        : reqUrl.origin;

    return { rpID: reqUrl.hostname, origin };
  }
  const configured = new URL(config.publicBaseUrl);
  const reqOrigin = c.req.header("Origin")?.trim();
  const forwardedHost = c.req.header("X-Forwarded-Host")?.split(",")[0]?.trim();
  if (
    !LOOPBACK_HOSTS.has(configured.hostname) &&
    (reqOrigin === configured.origin || forwardedHost === configured.host)
  ) {
    return { rpID: configured.hostname, origin: configured.origin };
  }

  return { rpID: reqUrl.hostname, origin: reqUrl.origin };
}

async function verifyPassword(
  password: string,
  config: LoadedConfig,
): Promise<boolean> {
  for (const secret of [config.adminPassword, config.adminToken]) {
    if (secret !== null && (await timingSafeEqualText(password, secret))) {
      return true;
    }
  }

  return (
    config.adminPasswordSha256 !== null &&
    timingSafeEqualText(await sha256Hex(password), config.adminPasswordSha256)
  );
}

async function hasActiveSession(
  db: SqlDatabase,
  rawToken: string,
  now: number,
): Promise<boolean> {
  const row = await db.first<{ token_hash: string }>(
    "SELECT token_hash FROM admin_sessions WHERE token_hash = ?1 AND expires_at > ?2",
    [await sha256Hex(rawToken), now],
  );

  return row !== null;
}

export async function createAdminSession(
  c: Context,
  db: SqlDatabase,
  config: LoadedConfig,
): Promise<void> {
  const now = unixNow();
  const rawToken = generateRandomToken("uptn_sess", 32);
  const userAgent = c.req.header("User-Agent")?.slice(0, 200) ?? null;

  await db.run(
    `INSERT INTO admin_sessions (token_hash, created_at, expires_at, user_agent)
     VALUES (?1, ?2, ?3, ?4)`,
    [await sha256Hex(rawToken), now, now + SESSION_TTL_SECS, userAgent],
  );

  const secure =
    new URL(c.req.url).protocol === "https:" ||
    config.publicBaseUrl.startsWith("https://");
  setCookie(c, SESSION_COOKIE, rawToken, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECS,
  });
}

export async function checkAdminAuth(
  c: Context,
  db: SqlDatabase,
  config: LoadedConfig,
): Promise<boolean> {
  const now = unixNow();
  const bearer = extractBearer(c);
  if (bearer) {
    if (
      config.adminToken !== null &&
      (await timingSafeEqualText(bearer, config.adminToken))
    ) {
      return true;
    }
    if (await hasActiveSession(db, bearer, now)) {
      return true;
    }
  }

  const sessionToken = getCookie(c, SESSION_COOKIE);
  if (sessionToken && (await hasActiveSession(db, sessionToken, now))) {
    return true;
  }

  if (config.cfAccess) {
    const cfJwt =
      c.req.header("Cf-Access-Jwt-Assertion") ??
      getCookie(c, "CF_Authorization");
    if (
      cfJwt &&
      (await verifyCloudflareAccessJwt(
        cfJwt,
        config.cfAccess.teamDomain,
        config.cfAccess.aud,
      ))
    ) {
      return true;
    }
  }

  return false;
}

export const requireAdmin =
  (db: SqlDatabase, config: LoadedConfig): MiddlewareHandler =>
  async (c, next) => {
    if (!(await checkAdminAuth(c, db, config))) {
      throw httpError(401, "Unauthorized");
    }
    await next();
  };

export async function handlePasswordLogin(
  c: Context,
  db: SqlDatabase,
  config: LoadedConfig,
): Promise<Response> {
  const body = await readJson<{
    "password"?: unknown;
    "cf-turnstile-response"?: unknown;
  }>(c);
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) {
    throw httpError(400, "Password is required");
  }
  if (!hasPasswordLogin(config)) {
    throw httpError(403, "Password login is not configured on this server");
  }
  await verifyTurnstileToken(c, config, body["cf-turnstile-response"], "login");
  if (!(await verifyPassword(password, config))) {
    throw httpError(401, "Incorrect password");
  }

  await createAdminSession(c, db, config);

  return c.json({ ok: true });
}

export async function handleLogout(
  c: Context,
  db: SqlDatabase,
): Promise<Response> {
  const sessionToken = getCookie(c, SESSION_COOKIE);
  if (sessionToken) {
    await db.run("DELETE FROM admin_sessions WHERE token_hash = ?1", [
      await sha256Hex(sessionToken),
    ]);
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });

  return c.json({ ok: true });
}
