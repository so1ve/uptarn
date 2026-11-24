#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { applyMigrations, openNodeSqlite } from "./db/node.ts";
import { runTick } from "./domain/index.ts";
import { errorMessage } from "./http.ts";

const PUBLIC_DIR = path.resolve(import.meta.dirname, "../public");

const FILE_BACKED_ENV_KEYS = [
  "ADMIN_PASSWORD",
  "ADMIN_PASSWORD_SHA256",
  "ADMIN_TOKEN",
  "ENROLLMENT_TOKEN",
  "CF_ACCESS_AUD",
  "TELEGRAM_BOT_TOKEN",
  "MATRIX_ACCESS_TOKEN",
] as const;

const { values } = parseArgs({
  options: {
    "host": { type: "string" },
    "port": { type: "string" },
    "db": { type: "string" },
    "tick-interval": { type: "string" },
    "help": { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(
    "Usage: uptarn-server [--host 127.0.0.1] [--port 8787] [--db ./uptarn.db] [--tick-interval 60]",
  );
  process.exit(0);
}

const env: Record<string, string | undefined> = { ...process.env };
for (const key of FILE_BACKED_ENV_KEYS) {
  if (env[key]?.trim()) {
    continue;
  }
  const filePath = env[`${key}_FILE`]?.trim();
  if (filePath) {
    env[key] = fs.readFileSync(filePath, "utf8").trim();
  }
}

const host = values.host ?? env.HOST?.trim() ?? "127.0.0.1";
const port = Number.parseInt(values.port ?? env.PORT ?? "8787", 10);
const tickIntervalSecs = Number.parseInt(
  values["tick-interval"] ?? env.TICK_INTERVAL_SECS ?? "60",
  10,
);
const dbPath = values.db?.trim() || env.UPTARN_DB_PATH?.trim() || "./uptarn.db";

const config = loadConfig(env);
const db = openNodeSqlite(dbPath);
const applied = await applyMigrations(db);
if (applied.length > 0) {
  console.log(
    JSON.stringify({ message: "applied database migrations", applied }),
  );
}

const indexPath = path.join(PUBLIC_DIR, "index.html");
const indexHtml = fs.existsSync(indexPath)
  ? fs.readFileSync(indexPath, "utf8")
  : null;

const app = createApp(db, config);
const staticHandler = serveStatic({ root: PUBLIC_DIR });
app.use("/assets/*", staticHandler);
app.use("/fonts/*", staticHandler);
app.use("/favicon.svg", staticHandler);
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

function shutdown() {
  clearInterval(tickTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  if ("closeAllConnections" in server) {
    server.closeAllConnections();
  }
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
