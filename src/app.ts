import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import {
  checkAdminAuth,
  handleDeletePasskey,
  handleLogout,
  handlePasskeyLoginOptions,
  handlePasskeyLoginVerify,
  handlePasskeyRegisterOptions,
  handlePasskeyRegisterVerify,
  handlePasswordLogin,
  requireAdmin,
} from "./auth/index.ts";
import type { LoadedConfig } from "./config.ts";
import type { SqlDatabase } from "./db/index.ts";
import {
  createNode,
  deleteTarget,
  getDashboardSnapshot,
  getNodeHistory,
  getPublicStatusSnapshot,
  ingestJobReport,
  ingestNodeReport,
  reorderTargets,
  rotateNodeToken,
  runTick,
  sendTestNotification,
  setNodePublic,
  setTargetMute,
  updateRuntimeSettings,
  upsertMonitor,
} from "./domain/index.ts";
import { errorMessage, extractBearer, httpError, readJson } from "./http.ts";
import type { TargetType } from "./shared/index.ts";
import { unixNow } from "./shared/index.ts";
import {
  parseCreateNodeInput,
  parseJobReportPayload,
  parseMuteInput,
  parseNodePatch,
  parseNodeReportPayload,
  parseOrderInput,
  parseSettingsPatch,
} from "./validation.ts";

function requireBearer(c: Context): string {
  const token = extractBearer(c);
  if (!token) {
    throw httpError(401, "Missing Authorization Bearer token");
  }

  return token;
}

async function removeOr404(
  c: Context,
  db: SqlDatabase,
  targetType: TargetType,
  id: string,
): Promise<Response> {
  if (!(await deleteTarget(db, targetType, id))) {
    throw httpError(404, "Not found");
  }

  return c.json({ ok: true });
}

export function createApp(db: SqlDatabase, config: LoadedConfig): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.text("ok\n"));

  app.get("/api/v1/boot", async (c) => {
    c.header("Cache-Control", "no-store");
    if (await checkAdminAuth(c, db, config)) {
      return c.json({
        mode: "admin",
        snapshot: await getDashboardSnapshot(db, config),
      });
    }

    return c.json({
      mode: "public",
      status: await getPublicStatusSnapshot(db, config),
    });
  });

  app.get("/api/v1/public/status", async (c) => {
    c.header("Cache-Control", "no-store");

    return c.json(await getPublicStatusSnapshot(db, config));
  });

  app.post("/api/v1/auth/login", (c) => handlePasswordLogin(c, db, config));
  app.post("/api/v1/auth/logout", (c) => handleLogout(c, db));
  app.post("/api/v1/auth/passkey/login/options", (c) =>
    handlePasskeyLoginOptions(c, db, config),
  );
  app.post("/api/v1/auth/passkey/login/verify", (c) =>
    handlePasskeyLoginVerify(c, db, config),
  );

  app.post("/api/v1/ingest/report", async (c) => {
    const token = requireBearer(c);
    const payload = parseNodeReportPayload(await readJson(c));
    const { registered } = await ingestNodeReport(
      db,
      config,
      payload,
      token,
      c.req.header("X-Uptarn-Enroll"),
    );

    return c.json({ ok: true, registered });
  });

  app.post("/api/v1/ingest/job", async (c) => {
    const token = requireBearer(c);
    await ingestJobReport(
      db,
      config,
      parseJobReportPayload(await readJson(c)),
      token,
    );

    return c.json({ ok: true });
  });

  app.use("/api/v1/admin/*", requireAdmin(db, config));

  app.get("/api/v1/admin/snapshot", async (c) =>
    c.json(await getDashboardSnapshot(db, config)),
  );

  app.get("/api/v1/admin/nodes/:id/history", async (c) => {
    const rawWindow = c.req.query("window");
    const parsed = rawWindow === undefined ? 21_600 : Number(rawWindow);
    if (!Number.isFinite(parsed) || parsed < 300 || parsed > 14 * 86_400) {
      throw httpError(400, "window must be between 300 and 1209600 seconds");
    }
    const result = await getNodeHistory(
      db,
      c.req.param("id"),
      Math.floor(parsed),
    );
    if (!result) {
      throw httpError(404, "Not found");
    }

    return c.json(result);
  });

  app.post("/api/v1/admin/nodes", async (c) =>
    c.json(
      {
        ok: true,
        ...(await createNode(db, parseCreateNodeInput(await readJson(c)))),
      },
      201,
    ),
  );

  app.put("/api/v1/admin/nodes/order", async (c) => {
    await reorderTargets(db, "node", parseOrderInput(await readJson(c)));

    return c.json({ ok: true });
  });

  app.post("/api/v1/admin/nodes/:id/rotate-token", async (c) =>
    c.json({ ok: true, ...(await rotateNodeToken(db, c.req.param("id"))) }),
  );

  app.patch("/api/v1/admin/nodes/:id", async (c) => {
    const { is_public } = parseNodePatch(await readJson(c));
    if (!(await setNodePublic(db, c.req.param("id"), is_public))) {
      throw httpError(404, "Not found");
    }

    return c.json({ ok: true, is_public });
  });

  app.delete("/api/v1/admin/nodes/:id", (c) =>
    removeOr404(c, db, "node", c.req.param("id")),
  );

  app.post("/api/v1/admin/monitors", async (c) =>
    c.json({ ok: true, id: await upsertMonitor(db, await readJson(c)) }),
  );

  app.put("/api/v1/admin/monitors/order", async (c) => {
    await reorderTargets(db, "monitor", parseOrderInput(await readJson(c)));

    return c.json({ ok: true });
  });

  app.delete("/api/v1/admin/monitors/:id", (c) =>
    removeOr404(c, db, "monitor", c.req.param("id")),
  );

  app.delete("/api/v1/admin/jobs/:key", (c) =>
    removeOr404(c, db, "job", c.req.param("key")),
  );

  app.post("/api/v1/admin/mute", async (c) => {
    const body = parseMuteInput(await readJson(c));
    const mutedUntil =
      body.muted_until ??
      (body.duration_secs && body.duration_secs > 0
        ? unixNow() + body.duration_secs
        : 0);
    if (
      !(await setTargetMute(db, body.target_type, body.target_id, mutedUntil))
    ) {
      throw httpError(404, "Target not found");
    }

    return c.json({ ok: true, muted_until: mutedUntil });
  });

  app.patch("/api/v1/admin/settings", async (c) => {
    const body = parseSettingsPatch(await readJson(c));
    const fromDuration =
      body.global_mute_secs === undefined
        ? undefined
        : body.global_mute_secs > 0
          ? unixNow() + body.global_mute_secs
          : 0;
    const settings = await updateRuntimeSettings(db, config, {
      auto_register: body.auto_register,
      rotate_enrollment_token: body.rotate_enrollment_token,
      global_muted_until: body.global_muted_until ?? fromDuration,
    });

    return c.json({
      ok: true,
      auto_register: settings.autoRegister,
      enrollment_token: settings.enrollmentToken,
      global_muted_until: settings.globalMutedUntil,
    });
  });

  app.post("/api/v1/admin/tick", async (c) =>
    c.json({
      ok: true,
      ...(await runTick(db, config, { forceMonitors: true })),
    }),
  );

  app.post("/api/v1/admin/notifications/test", async (c) =>
    c.json({ ok: true, delivery: await sendTestNotification(config) }),
  );

  app.post("/api/v1/admin/passkeys/register/options", (c) =>
    handlePasskeyRegisterOptions(c, db, config),
  );
  app.post("/api/v1/admin/passkeys/register/verify", (c) =>
    handlePasskeyRegisterVerify(c, db, config),
  );
  app.delete("/api/v1/admin/passkeys/:id", (c) =>
    handleDeletePasskey(c, db, config),
  );

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status);
    }
    const message = errorMessage(error);
    console.error(
      JSON.stringify({
        message: "unhandled server error",
        method: c.req.method,
        path: c.req.path,
        error: message,
      }),
    );

    return c.json({ error: message }, 500);
  });

  return app;
}
