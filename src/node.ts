import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { applyMigrations, openNodeSqlite } from "./db/node.ts";
import { runTick } from "./domain/index.ts";
import { errorMessage } from "./shared/index.ts";

const DIST_DIR = path.resolve(import.meta.dirname, "../web/dist");

const FILE_BACKED_ENV_KEYS = [
  "ADMIN_PASSWORD",
  "ADMIN_PASSWORD_SHA256",
  "ADMIN_TOKEN",
  "ENROLLMENT_TOKEN",
  "CF_ACCESS_AUD",
  "TELEGRAM_BOT_TOKEN",
  "MATRIX_ACCESS_TOKEN",
] as const;

export interface NodeServerOptions {
  host?: string;
  port?: number;
  dbPath?: string;
  tickIntervalSecs?: number;
  env?: Record<string, string | undefined>;
}

export interface RunningNodeServer {
  close: () => Promise<void>;
}

function hydrateFileBackedEnv(
  baseEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv };
  for (const key of FILE_BACKED_ENV_KEYS) {
    if (env[key]?.trim()) {
      continue;
    }
    const filePath = env[`${key}_FILE`]?.trim();
    if (filePath) {
      env[key] = fs.readFileSync(filePath, "utf8").trim();
    }
  }

  return env;
}

export async function runDatabaseMigrations(
  dbPath: string,
): Promise<{ applied: string[]; dbPath: string }> {
  const db = openNodeSqlite(dbPath);
  try {
    const applied = await applyMigrations(db);

    return { applied, dbPath };
  } finally {
    db.close();
  }
}

export async function startNodeServer(
  options: NodeServerOptions = {},
): Promise<RunningNodeServer> {
  const env = hydrateFileBackedEnv(options.env ?? process.env);
  const host = options.host ?? env.HOST?.trim() ?? "127.0.0.1";
  const port = options.port ?? Number.parseInt(env.PORT ?? "8787", 10);
  const tickIntervalSecs =
    options.tickIntervalSecs ??
    Number.parseInt(env.TICK_INTERVAL_SECS ?? "60", 10);
  const dbPath =
    options.dbPath?.trim() || env.UPTARN_DB_PATH?.trim() || "./uptarn.db";

  const config = loadConfig(env);
  const db = openNodeSqlite(dbPath);
  const applied = await applyMigrations(db);
  if (applied.length > 0) {
    console.log(
      JSON.stringify({ message: "applied database migrations", applied }),
    );
  }

  const indexPath = path.join(DIST_DIR, "index.html");
  const indexHtml = fs.existsSync(indexPath)
    ? fs.readFileSync(indexPath, "utf8")
    : null;

  const app = createApp(db, config);
  const staticHandler = serveStatic({ root: DIST_DIR });
  for (const route of [
    "/assets/*",
    "/fonts/*",
    "/favicon.svg",
    "/logo-dark.svg",
    "/logo-light.svg",
  ]) {
    app.use(route, staticHandler);
  }
  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/api/")) {
      await next();

      return;
    }
    c.header("Cache-Control", "no-store");

    return indexHtml
      ? c.html(indexHtml)
      : c.text("Frontend bundle missing. Run `pnpm run build`.", 503);
  });

  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let tickInFlight = false;
  if (tickIntervalSecs > 0) {
    tickTimer = setInterval(() => {
      if (tickInFlight) {
        return;
      }
      tickInFlight = true;
      void runTick(db, config)
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              message: "scheduled tick failed",
              error: errorMessage(error),
            }),
          );
        })
        .finally(() => {
          tickInFlight = false;
        });
    }, tickIntervalSecs * 1000);
    tickTimer.unref();
  }

  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    console.log(
      JSON.stringify({
        message: "uptarn hub listening",
        host,
        port: info.port,
        db: dbPath,
        tick_interval_secs: tickIntervalSecs,
        public_base_url: config.publicBaseUrl,
      }),
    );
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(tickTimer);
        server.close(() => {
          db.close();
          resolve();
        });
        if ("closeAllConnections" in server) {
          server.closeAllConnections();
        }
      }),
  };
}
