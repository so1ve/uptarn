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
  publicNodeKey,
  requireAdmin,
} from "./auth/index.ts";
import type { LoadedConfig } from "./config.ts";
import type { SqlDatabase } from "./db/index.ts";
import {
  createNode,
  createPushJob,
  deleteMaintenance,
  deleteTarget,
  getDashboardSnapshot,
  getNodeHistory,
  getPublicStatusSnapshot,
  handleJobPing,
  ingestNodeReport,
  reorderTargets,
  rotateJobPingToken,
  rotateNodeToken,
  runTick,
  sendTestNotification,
  setTargetMute,
  updateMonitor,
  updateNode,
  updatePushJob,
  updateRuntimeSettings,
  upsertMaintenance,
  upsertMonitor,
} from "./domain/index.ts";
import {
  extractBearer,
  httpError,
  readJson,
  readOptionalText,
} from "./http.ts";
import type { TargetType } from "./shared/index.ts";
import { errorMessage, unixNow } from "./shared/index.ts";
import {
  parseCreateNodeInput,
  parseJobPatch,
  parseMonitorPatch,
  parseMuteInput,
  parseNodePatch,
  parseNodeReportPayload,
  parseOrderInput,
  parseSettingsPatch,
} from "./validation.ts";

const MAX_INGEST_REPORT_BYTES = 256 * 1024;
const MAX_PING_BODY_BYTES = 16 * 1024;

const resolveMutedUntil = (
  mutedUntil?: number,
  durationSecs?: number,
): number | undefined =>
  mutedUntil ??
  (durationSecs === undefined
    ? undefined
    : durationSecs > 0
      ? unixNow() + durationSecs
      : 0);

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

export interface LiveSyncHooks {
  onNodeVisibility?: (
    nodeId: string,
    publicKey: string,
    isPublic: boolean,
  ) => void;
  onNodeDeleted?: (nodeId: string) => void;
}

export function createApp(
  db: SqlDatabase,
  config: LoadedConfig,
  liveHooks?: LiveSyncHooks,
): Hono {
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
    const payload = parseNodeReportPayload(
      await readJson(c, MAX_INGEST_REPORT_BYTES),
    );
    const { registered } = await ingestNodeReport(
      db,
      config,
      payload,
      token,
      c.req.header("X-Uptarn-Enroll"),
    );

    if (payload.is_public !== undefined && liveHooks?.onNodeVisibility) {
      liveHooks.onNodeVisibility(
        payload.node_id,
        await publicNodeKey(payload.node_id),
        payload.is_public,
      );
    }

    return c.json({ ok: true, registered });
  });

  const pingRoute = (action: "ok" | "start" | "fail") => async (c: Context) => {
    c.header("Cache-Control", "no-store");
    const rawDuration =
      c.req.query("duration_ms") ?? c.req.header("X-Uptarn-Duration-Ms");
    const parsedDuration =
      rawDuration === undefined || rawDuration === ""
        ? null
        : Number(rawDuration);
    const durationMs =
      parsedDuration !== null &&
      Number.isFinite(parsedDuration) &&
      parsedDuration >= 0
        ? Math.floor(parsedDuration)
        : null;
    const body = await readOptionalText(c, MAX_PING_BODY_BYTES);
    await handleJobPing(db, config, c.req.param("token") ?? "", action, {
      body,
      durationMs,
    });

    return c.text("ok\n");
  };

  app.get("/ping/:token", pingRoute("ok"));
  app.post("/ping/:token", pingRoute("ok"));
  app.get("/ping/:token/start", pingRoute("start"));
  app.post("/ping/:token/start", pingRoute("start"));
  app.get("/ping/:token/fail", pingRoute("fail"));
  app.post("/ping/:token/fail", pingRoute("fail"));

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
    const nodeId = c.req.param("id");
    const patch = parseNodePatch(await readJson(c));
    if (!(await updateNode(db, nodeId, patch))) {
      throw httpError(404, "Not found");
    }
    if (patch.is_public !== undefined && liveHooks?.onNodeVisibility) {
      liveHooks.onNodeVisibility(
        nodeId,
        await publicNodeKey(nodeId),
        patch.is_public,
      );
    }

    return c.json({ ok: true, ...patch });
  });

  app.delete("/api/v1/admin/nodes/:id", async (c) => {
    const nodeId = c.req.param("id");
    const res = await removeOr404(c, db, "node", nodeId);
    liveHooks?.onNodeDeleted?.(nodeId);

    return res;
  });

  app.post("/api/v1/admin/monitors", async (c) =>
    c.json({ ok: true, id: await upsertMonitor(db, await readJson(c)) }),
  );

  app.patch("/api/v1/admin/monitors/:id", async (c) => {
    const patch = parseMonitorPatch(await readJson(c));
    if (!(await updateMonitor(db, c.req.param("id"), patch))) {
      throw httpError(404, "Not found");
    }

    return c.json({ ok: true, ...patch });
  });

  app.put("/api/v1/admin/monitors/order", async (c) => {
    await reorderTargets(db, "monitor", parseOrderInput(await readJson(c)));

    return c.json({ ok: true });
  });

  app.delete("/api/v1/admin/monitors/:id", (c) =>
    removeOr404(c, db, "monitor", c.req.param("id")),
  );

  app.post("/api/v1/admin/jobs", async (c) =>
    c.json(
      { ok: true, ...(await createPushJob(db, config, await readJson(c))) },
      201,
    ),
  );

  app.patch("/api/v1/admin/jobs/:key", async (c) => {
    const patch = parseJobPatch(await readJson(c));
    if (!(await updatePushJob(db, c.req.param("key"), patch))) {
      throw httpError(404, "Not found");
    }

    return c.json({ ok: true, ...patch });
  });

  app.post("/api/v1/admin/jobs/:key/rotate-token", async (c) =>
    c.json({
      ok: true,
      ...(await rotateJobPingToken(db, config, c.req.param("key"))),
    }),
  );

  app.delete("/api/v1/admin/jobs/:key", (c) =>
    removeOr404(c, db, "job", c.req.param("key")),
  );

  app.post("/api/v1/admin/maintenances", async (c) =>
    c.json({ ok: true, id: await upsertMaintenance(db, await readJson(c)) }),
  );

  app.delete("/api/v1/admin/maintenances/:id", async (c) => {
    if (!(await deleteMaintenance(db, c.req.param("id")))) {
      throw httpError(404, "Not found");
    }

    return c.json({ ok: true });
  });

  app.post("/api/v1/admin/mute", async (c) => {
    const body = parseMuteInput(await readJson(c));
    const mutedUntil =
      resolveMutedUntil(body.muted_until, body.duration_secs) ?? 0;
    if (
      !(await setTargetMute(db, body.target_type, body.target_id, mutedUntil))
    ) {
      throw httpError(404, "Target not found");
    }

    return c.json({ ok: true, muted_until: mutedUntil });
  });

  app.patch("/api/v1/admin/settings", async (c) => {
    const body = parseSettingsPatch(await readJson(c));
    const settings = await updateRuntimeSettings(db, config, {
      auto_register: body.auto_register,
      rotate_enrollment_token: body.rotate_enrollment_token,
      global_muted_until: resolveMutedUntil(
        body.global_muted_until,
        body.global_mute_secs,
      ),
      site_title: body.site_title,
      site_links: body.site_links,
    });

    return c.json({
      ok: true,
      auto_register: settings.autoRegister,
      enrollment_token: settings.enrollmentToken,
      global_muted_until: settings.globalMutedUntil,
      site_title: settings.siteTitle,
      site_links: settings.siteLinks,
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
