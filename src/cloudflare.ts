import { createApp } from "./app.ts";
import type { ServerRuntimeEnv } from "./config.ts";
import { loadConfig } from "./config.ts";
import { d1Adapter } from "./db/index.ts";
import { runTick } from "./domain/index.ts";

export interface CloudflareWorkerEnv extends ServerRuntimeEnv {
  DB: D1Database;
}

export default {
  fetch(
    request: Request,
    env: CloudflareWorkerEnv,
    ctx: ExecutionContext,
  ): Response | Promise<Response> {
    return createApp(d1Adapter(env.DB), loadConfig(env)).fetch(
      request,
      env,
      ctx,
    );
  },

  scheduled(
    _controller: ScheduledController,
    env: CloudflareWorkerEnv,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(runTick(d1Adapter(env.DB), loadConfig(env)));
  },
} satisfies ExportedHandler<CloudflareWorkerEnv>;
