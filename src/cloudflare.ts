import { createApp } from "./app.ts";
import type { ServerRuntimeEnv } from "./config.ts";
import { loadConfig } from "./config.ts";
import { d1Adapter } from "./db/index.ts";
import { runTick } from "./domain/index.ts";

export interface CloudflareWorkerEnv extends ServerRuntimeEnv {
  DB: D1Database;
}

const PUBLIC_CACHE_TTL_SECS = 10;
const CACHEABLE_PUBLIC_PATHS = new Set([
  "/api/v1/boot",
  "/api/v1/public/status",
]);

function hasAuthCredentials(request: Request): boolean {
  if (
    request.headers.has("Authorization") ||
    request.headers.has("Cf-Access-Jwt-Assertion")
  ) {
    return true;
  }
  const cookie = request.headers.get("Cookie");

  return (
    cookie !== null &&
    /(?:^|;\s*)(?:uptarn_session|CF_Authorization)=/.test(cookie)
  );
}

async function handleFetch(
  request: Request,
  env: CloudflareWorkerEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const canCache =
    request.method === "GET" &&
    CACHEABLE_PUBLIC_PATHS.has(url.pathname) &&
    !hasAuthCredentials(request);

  if (!canCache) {
    return createApp(d1Adapter(env.DB), loadConfig(env)).fetch(
      request,
      env,
      ctx,
    );
  }

  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(`${url.origin}${url.pathname}`, {
    method: "GET",
  });
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  const response = await createApp(d1Adapter(env.DB), loadConfig(env)).fetch(
    request,
    env,
    ctx,
  );
  if (response.ok) {
    const cacheable = new Response(response.body, response);
    cacheable.headers.set(
      "Cache-Control",
      `public, max-age=0, s-maxage=${PUBLIC_CACHE_TTL_SECS}`,
    );
    ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));

    return cacheable;
  }

  return response;
}

export default {
  fetch(
    request: Request,
    env: CloudflareWorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return handleFetch(request, env, ctx);
  },

  scheduled(
    _controller: ScheduledController,
    env: CloudflareWorkerEnv,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(runTick(d1Adapter(env.DB), loadConfig(env)));
  },
} satisfies ExportedHandler<CloudflareWorkerEnv>;
