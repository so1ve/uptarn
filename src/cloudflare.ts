import { createApp } from "./app.ts";
import { authenticateLiveAgent, authenticateLiveViewer } from "./auth/index.ts";
import type { ServerRuntimeEnv } from "./config.ts";
import { loadConfig } from "./config.ts";
import { d1Adapter } from "./db/index.ts";
import { runTick } from "./domain/index.ts";
import type { LiveHub } from "./live/durable-object.ts";

export { LiveHub } from "./live/durable-object.ts";

export interface CloudflareWorkerEnv extends ServerRuntimeEnv {
  DB: D1Database;
  LIVE_HUB?: DurableObjectNamespace<LiveHub>;
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

async function handleLiveUpgrade(
  request: Request,
  env: CloudflareWorkerEnv,
  liveHub: DurableObjectNamespace<LiveHub>,
  pathname: string,
): Promise<Response> {
  const db = d1Adapter(env.DB);
  const stub = liveHub.getByName("global");

  if (pathname === "/api/v1/ingest/live") {
    const auth = await authenticateLiveAgent(db, request);
    if (!auth) {
      return new Response("Unauthorized", { status: 401 });
    }
    const headers = new Headers(request.headers);
    headers.set("X-Uptarn-Role", "agent");
    headers.set("X-Uptarn-Node-Id", auth.nodeId);
    headers.set("X-Uptarn-Public-Key", auth.publicKey);
    headers.set("X-Uptarn-Is-Public", auth.isPublic ? "1" : "0");

    return stub.fetch(new Request(request.url, { headers }));
  }

  const scope = await authenticateLiveViewer(db, loadConfig(env), request);
  const headers = new Headers(request.headers);
  headers.set("X-Uptarn-Role", "viewer");
  headers.set("X-Uptarn-Scope", scope);

  return stub.fetch(new Request(request.url, { headers }));
}

function buildWorkerApp(env: CloudflareWorkerEnv, ctx: ExecutionContext) {
  const liveHub = env.LIVE_HUB;

  return createApp(
    d1Adapter(env.DB),
    loadConfig(env),
    liveHub
      ? {
          onNodeVisibility: (nodeId, publicKey, isPublic) => {
            ctx.waitUntil(
              liveHub
                .getByName("global")
                .setNodeVisibility(nodeId, publicKey, isPublic),
            );
          },
          onNodeDeleted: (nodeId) => {
            ctx.waitUntil(liveHub.getByName("global").removeNode(nodeId));
          },
        }
      : undefined,
  );
}

async function handleFetch(
  request: Request,
  env: CloudflareWorkerEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    request.method === "GET" &&
    (url.pathname === "/api/v1/ingest/live" ||
      url.pathname === "/api/v1/live") &&
    request.headers.get("Upgrade")?.toLowerCase() === "websocket"
  ) {
    if (!env.LIVE_HUB) {
      return new Response("Live hub not configured", { status: 503 });
    }

    return handleLiveUpgrade(request, env, env.LIVE_HUB, url.pathname);
  }

  const canCache =
    request.method === "GET" &&
    CACHEABLE_PUBLIC_PATHS.has(url.pathname) &&
    !hasAuthCredentials(request);

  if (!canCache) {
    return buildWorkerApp(env, ctx).fetch(request, env, ctx);
  }

  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(`${url.origin}${url.pathname}`, {
    method: "GET",
  });
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  const response = await buildWorkerApp(env, ctx).fetch(request, env, ctx);
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
