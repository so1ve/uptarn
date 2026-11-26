import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.ts";
import { hmacSha256Hex, sha256Hex } from "../src/auth/index.ts";
import {
  applySyncPlan,
  computeSyncPlan,
  parseSyncSpec,
} from "../src/cli/sync.ts";
import { loadConfig } from "../src/config.ts";
import type { NodeDatabase } from "../src/db/node.ts";
import { applyMigrations, openNodeSqlite } from "../src/db/node.ts";
import {
  createPushJob,
  handleJobPing,
  ingestNodeReport,
  runTick,
  upsertMonitor,
} from "../src/domain/index.ts";
import type { DashboardSnapshot } from "../src/shared/index.ts";
import {
  LiveStateBuffer,
  pairIncidentEvents,
  parseLiveIngestFrame,
} from "../src/shared/index.ts";

describe("uptarn portable server", () => {
  let db: NodeDatabase;

  beforeEach(async () => {
    db = openNodeSqlite(":memory:");
    await applyMigrations(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    db.close();
  });

  it("enforces admin auth boundary and supports password session login", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "http://localhost:8787",
      ADMIN_PASSWORD: "correct-horse-battery",
      ADMIN_TOKEN: "cli-secret-token",
    });
    const app = createApp(db, config);

    const unauthSnap = await app.request("/api/v1/admin/snapshot");

    expect(unauthSnap.status).toBe(401);

    const guestBoot = await app.request("/api/v1/boot");

    expect(guestBoot.status).toBe(200);
    await expect(guestBoot.json()).resolves.toMatchObject({
      mode: "public",
      status: {
        auth: {
          password_enabled: true,
        },
      },
    });

    const badLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });

    expect(badLogin.status).toBe(401);

    const goodLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct-horse-battery" }),
    });

    expect(goodLogin.status).toBe(200);

    const setCookie = goodLogin.headers.get("set-cookie") ?? "";

    expect(setCookie).toContain("uptarn_session=");

    const cookieHeader = setCookie.split(";")[0];

    const authedBoot = await app.request("/api/v1/boot", {
      headers: { Cookie: cookieHeader },
    });

    expect(authedBoot.status).toBe(200);
    await expect(authedBoot.json()).resolves.toMatchObject({
      mode: "admin",
    });

    const cliSnap = await app.request("/api/v1/admin/snapshot", {
      headers: { Authorization: "Bearer cli-secret-token" },
    });

    expect(cliSnap.status).toBe(200);
  });

  it("handles manual node registration, optional auto-registration, and extensible client payloads", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-tok",
    });
    const app = createApp(db, config);

    const rejected = await app.request("/api/v1/ingest/report", {
      method: "POST",
      headers: {
        "Authorization": "Bearer random-tok",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        node_id: "router",
        system: { uptime_secs: 3600 },
      }),
    });

    expect(rejected.status).toBe(401);

    const createRes = await app.request("/api/v1/admin/nodes", {
      method: "POST",
      headers: {
        "Authorization": "Bearer admin-tok",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "dsm",
        label: "Synology DSM",
        interval_secs: 300,
      }),
    });

    expect(createRes.status).toBe(201);

    const createdDsm = await createRes.json<{ id: string; token: string }>();

    const dsmIngest = await app.request("/api/v1/ingest/report", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${createdDsm.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        node_id: "dsm",
        system: {
          uptime_secs: 864_000,
          mem_used_bytes: 1_000_000_000,
          mem_total_bytes: 4_000_000_000,
          swap_used_bytes: 128_000_000,
          swap_total_bytes: 2_000_000_000,
          rx_bytes: 10_000,
          tx_bytes: 20_000,
        },
        mounts: [
          {
            path: "/volume2",
            label: "homelab",
            used_bytes: 500_000_000_000,
            total_bytes: 2_000_000_000_000,
            status: "ok",
          },
        ],
      }),
    });

    expect(dsmIngest.status).toBe(200);

    await db.run(
      "UPDATE nodes SET prev_net_at = prev_net_at - 60 WHERE id = 'dsm'",
    );
    const dsmIngest2 = await app.request("/api/v1/ingest/report", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${createdDsm.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        node_id: "dsm",
        system: {
          uptime_secs: 864_060,
          mem_used_bytes: 1_100_000_000,
          mem_total_bytes: 4_000_000_000,
          swap_used_bytes: 128_000_000,
          swap_total_bytes: 2_000_000_000,
          rx_bytes: 70_000,
          tx_bytes: 50_000,
        },
        mounts: [
          {
            path: "/volume2",
            label: "homelab",
            used_bytes: 500_000_000_000,
            total_bytes: 2_000_000_000_000,
            status: "ok",
          },
        ],
      }),
    });

    expect(dsmIngest2.status).toBe(200);

    const histRes = await app.request(
      "/api/v1/admin/nodes/dsm/history?window=86400",
      { headers: { Authorization: "Bearer admin-tok" } },
    );

    expect(histRes.status).toBe(200);

    const histBody = await histRes.json<{
      node_id: string;
      window_secs: number;
      history: Record<string, { ts: number; value: number }[]>;
    }>();

    expect(histBody.node_id).toBe("dsm");
    expect(histBody.window_secs).toBe(86_400);
    expect(histBody.history._rx_bps?.length).toBeGreaterThan(0);
    expect(histBody.history._tx_bps?.length).toBeGreaterThan(0);

    const createSecondNode = await app.request("/api/v1/admin/nodes", {
      method: "POST",
      headers: {
        "Authorization": "Bearer admin-tok",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: "alpha", label: "Alpha" }),
    });

    expect(createSecondNode.status).toBe(201);

    const reorderRes = await app.request("/api/v1/admin/nodes/order", {
      method: "PUT",
      headers: {
        "Authorization": "Bearer admin-tok",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids: ["alpha", "dsm"] }),
    });

    expect(reorderRes.status).toBe(200);

    const orderedSnap = await app.request("/api/v1/admin/snapshot", {
      headers: { Authorization: "Bearer admin-tok" },
    });
    const orderedBody = await orderedSnap.json<{ nodes: { id: string }[] }>();

    expect(orderedBody.nodes.slice(0, 2).map((n) => n.id)).toEqual([
      "alpha",
      "dsm",
    ]);

    const managedReport = await app.request("/api/v1/ingest/report", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${createdDsm.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        node_id: "dsm",
        is_public: true,
        monitors: [
          {
            key: "nas_web",
            name: "NAS Web",
            from: "hub",
            url: "https://nas.example.com/healthz",
            public_url: "https://nas.example.com",
            is_public: true,
          },
        ],
      }),
    });

    expect(managedReport.status).toBe(200);

    const lockedNodePatch = await app.request("/api/v1/admin/nodes/dsm", {
      method: "PATCH",
      headers: {
        "Authorization": "Bearer admin-tok",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ is_public: false }),
    });

    expect(lockedNodePatch.status).toBe(409);

    const lockedMonEdit = await app.request("/api/v1/admin/monitors", {
      method: "POST",
      headers: {
        "Authorization": "Bearer admin-tok",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "dsm:nas_web",
        name: "Tampered",
        url: "https://nas.example.com",
      }),
    });

    expect(lockedMonEdit.status).toBe(409);

    const lockedMonDel = await app.request(
      "/api/v1/admin/monitors/dsm%3Anas_web",
      {
        method: "DELETE",
        headers: { Authorization: "Bearer admin-tok" },
      },
    );

    expect(lockedMonDel.status).toBe(409);

    const pubSnap = await app.request("/api/v1/public/status");
    const pubBody = await pubSnap.json<{
      monitors: { name: string; public_url: string | null }[];
    }>();

    expect(pubBody.monitors.find((m) => m.name === "NAS Web")?.public_url).toBe(
      "https://nas.example.com/",
    );

    const badPublicUrl = await app.request("/api/v1/admin/monitors", {
      method: "POST",
      headers: {
        "Authorization": "Bearer admin-tok",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Bad",
        url: "https://example.com",
        public_url: "javascript:alert(1)",
      }),
    });

    expect(badPublicUrl.status).toBe(400);

    const clearedReport = await app.request("/api/v1/ingest/report", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${createdDsm.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        node_id: "dsm",
        monitors: [],
      }),
    });

    expect(clearedReport.status).toBe(200);

    const unlockedSnap = await app.request("/api/v1/admin/snapshot", {
      headers: { Authorization: "Bearer admin-tok" },
    });
    const unlockedBody = await unlockedSnap.json<{
      nodes: { id: string; is_public: boolean; public_managed: boolean }[];
      monitors: { id: string }[];
    }>();
    const dsmAfter = unlockedBody.nodes.find((n) => n.id === "dsm")!;

    expect(dsmAfter.is_public).toBeTruthy();
    expect(dsmAfter.public_managed).toBeFalsy();
    expect(
      unlockedBody.monitors.some((m) => m.id === "dsm:nas_web"),
    ).toBeFalsy();

    const enableRes = await app.request("/api/v1/admin/settings", {
      method: "PATCH",
      headers: {
        "Authorization": "Bearer admin-tok",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ auto_register: true }),
    });
    const settingsData = await enableRes.json<{
      auto_register: boolean;
      enrollment_token: string;
    }>();

    expect(settingsData.auto_register).toBeTruthy();
    expect(settingsData.enrollment_token).toMatch(/^uptn_enroll_/);

    const routerOwnToken = "uptn_router_isolated_secret_12345";
    const routerEnroll = await app.request("/api/v1/ingest/report", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${routerOwnToken}`,
        "X-Uptarn-Enroll": settingsData.enrollment_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        node_id: "router",
        label: "OpenWrt Gateway",
        system: { uptime_secs: 172_800 },
        checks: [
          {
            key: "tailscale",
            label: "Tailscale",
            group: "network",
            status: "ok",
            summary: "connected",
          },
          {
            key: "ipv6_wan",
            label: "WAN IPv6",
            group: "network",
            status: "ok",
            summary: "/60 prefix delegated",
          },
        ],
        info: [
          {
            key: "wan6",
            label: "WAN IPv6",
            value: "2001:db8:1::1",
          },
        ],
      }),
    });

    expect(routerEnroll.status).toBe(200);
    await expect(routerEnroll.json()).resolves.toEqual({
      ok: true,
      registered: true,
    });

    await app.request("/api/v1/admin/settings", {
      method: "PATCH",
      headers: {
        "Authorization": "Bearer admin-tok",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ auto_register: false }),
    });

    const routerFollowup = await app.request("/api/v1/ingest/report", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${routerOwnToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        node_id: "router",
        system: { uptime_secs: 172_860 },
      }),
    });

    expect(routerFollowup.status).toBe(200);
    await expect(routerFollowup.json()).resolves.toEqual({
      ok: true,
      registered: false,
    });
  });

  it("debounces transient failures, isolates multi-channel IM delivery, and detects offline/overdue targets", async () => {
    vi.useFakeTimers();

    const sentRequests: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", (async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("api.telegram.org")) {
        sentRequests.push({ url, body: String(init?.body ?? "") });

        return Response.json({ ok: true }, { status: 200 });
      }
      if (url.includes("matrix.example.com")) {
        sentRequests.push({ url, body: String(init?.body ?? "") });

        return new Response("bad gateway", { status: 502 });
      }
      if (url === "https://vault.example.com/") {
        return new Response("Vault alive", { status: 200 });
      }

      return new Response("down", { status: 503 });
    }) satisfies typeof fetch);

    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-tok",
      ENROLLMENT_TOKEN: "enroll-tok",
      AUTO_REGISTER: "true",
      FAILURE_THRESHOLD: "2",
      TELEGRAM_BOT_TOKEN: "tg-bot",
      TELEGRAM_CHAT_ID: "12345",
      MATRIX_HOMESERVER: "https://matrix.example.com",
      MATRIX_ACCESS_TOKEN: "mx-tok",
      MATRIX_ROOM_ID: "!ops:example.com",
    });

    vi.setSystemTime(1000 * 1000);
    await ingestNodeReport(
      db,
      config,
      {
        node_id: "homelab",
        interval_secs: 60,
        grace_secs: 60,
        system: { uptime_secs: 1000 },
        checks: [
          {
            key: "systemd",
            label: "systemd",
            status: "fail",
            summary: "failed: ddclient.service",
          },
        ],
        series: [
          {
            key: "tcp.edge",
            label: "Edge Relay",
            unit: "ms",
            value: 68,
            loss_pct: 0,
            status: "ok",
          },
        ],
      },
      "enroll-tok",
    );

    expect(sentRequests).toHaveLength(0);

    vi.setSystemTime(1060 * 1000);
    await ingestNodeReport(
      db,
      config,
      {
        node_id: "homelab",
        system: { uptime_secs: 1060 },
        checks: [
          {
            key: "systemd",
            label: "systemd",
            status: "fail",
            summary: "failed: ddclient.service",
          },
        ],
      },
      "enroll-tok",
    );

    expect(sentRequests).toHaveLength(2);
    expect(sentRequests[0].body).toContain("🔴");
    expect(sentRequests[0].body).toContain(
      "<blockquote>failed: ddclient.service</blockquote>",
    );
    expect(sentRequests[0].body).toContain("/admin/nodes/homelab");

    sentRequests.length = 0;
    vi.setSystemTime(1120 * 1000);
    await ingestNodeReport(
      db,
      config,
      {
        node_id: "homelab",
        system: { uptime_secs: 1120 },
        checks: [
          {
            key: "systemd",
            label: "systemd",
            status: "ok",
            summary: "0 failed units",
          },
        ],
      },
      "enroll-tok",
    );

    expect(sentRequests).toHaveLength(2);
    expect(sentRequests[0].body).toContain("🟢");
    expect(sentRequests[0].body).toContain("recovered after");
    await expect(
      db.all("SELECT incident_key FROM alert_states"),
    ).resolves.toEqual([]);

    sentRequests.length = 0;
    const pushJob = await createPushJob(db, config, {
      key: "homelab-restic",
      label: "Restic Backup",
      interval_secs: 3600,
      grace_secs: 600,
    });
    await handleJobPing(db, config, pushJob.token, "ok", {
      durationMs: 14_200,
      body: "snapshot a1b2c3d saved",
    });

    await upsertMonitor(db, {
      id: "vault",
      name: "Vault",
      url: "https://vault.example.com/",
      expected_body: "Vault",
    });

    vi.setSystemTime(6000 * 1000);
    const tickRes = await runTick(db, config);

    expect(tickRes.probed_monitors).toBe(1);
    expect(sentRequests).toHaveLength(2);

    const bodies = sentRequests.map((r) => r.body).join("\n");

    expect(bodies).toContain("2 alerts firing");
    expect(bodies).toContain("homelab / Connectivity");
    expect(bodies).toContain("Job / Restic Backup");
  });

  it("validates admin inputs and keeps expected_status_max >= expected_status_min", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "http://localhost:8787",
      ADMIN_TOKEN: "admin-tok",
    });
    const app = createApp(db, config);
    const headers = {
      "Authorization": "Bearer admin-tok",
      "Content-Type": "application/json",
    };

    const badNode = await app.request("/api/v1/admin/nodes", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "web", interval_secs: -5 }),
    });

    expect(badNode.status).toBe(400);

    const badSettings = await app.request("/api/v1/admin/settings", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ global_mute_secs: "1h" }),
    });

    expect(badSettings.status).toBe(400);

    const openApp = createApp(
      db,
      loadConfig({
        PUBLIC_BASE_URL: "http://localhost:8787",
        AUTO_REGISTER: "true",
      }),
    );
    const missingEnroll = await openApp.request("/api/v1/ingest/report", {
      method: "POST",
      headers: {
        "Authorization": "Bearer any-random-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        node_id: "intruder",
        system: { uptime_secs: 10 },
      }),
    });

    expect(missingEnroll.status).toBe(401);

    const redirectMon = await app.request("/api/v1/admin/monitors", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Redirect",
        url: "https://example.com/",
        expected_status_min: 301,
      }),
    });

    expect(redirectMon.status).toBe(200);

    const { id: redirectId } = await redirectMon.json<{ id: string }>();

    const redirectRow = await db.first<{ probe_json: string }>(
      "SELECT probe_json FROM monitors WHERE id = ?1",
      [redirectId],
    );

    expect(JSON.parse(redirectRow!.probe_json)).toMatchObject({
      expected_status_min: 301,
      expected_status_max: 301,
    });

    // Two CJK-named monitors without explicit IDs must not collide or overwrite each other.
    const cjk1 = await app.request("/api/v1/admin/monitors", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "个人博客",
        url: "https://blog.example.com/",
      }),
    });
    const cjk2 = await app.request("/api/v1/admin/monitors", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "密码库",
        url: "https://vault.example.com/",
      }),
    });
    const id1 = (await cjk1.json<{ id: string }>()).id;
    const id2 = (await cjk2.json<{ id: string }>()).id;

    expect(id1).not.toBe(id2);

    // Force-tick via admin endpoint re-probes immediately, and pausing clears active incidents.
    let statusToReturn = 503;
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response("probe", {
          status: statusToReturn,
        })) satisfies typeof fetch,
    );

    await app.request("/api/v1/admin/tick", { method: "POST", headers });
    await app.request("/api/v1/admin/tick", { method: "POST", headers });

    await expect(
      db.all(
        "SELECT incident_key FROM alert_states WHERE target_type = 'monitor'",
      ),
    ).resolves.toHaveLength(3);

    await app.request("/api/v1/admin/monitors", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: id1,
        name: "个人博客",
        url: "https://blog.example.com/",
        enabled: false,
      }),
    });

    await expect(
      db.first("SELECT incident_key FROM alert_states WHERE target_id = ?1", [
        id1,
      ]),
    ).resolves.toBeNull();

    statusToReturn = 200;
    const forcedTick = await (
      await app.request("/api/v1/admin/tick", { method: "POST", headers })
    ).json<{ probed_monitors: number }>();

    expect(forcedTick.probed_monitors).toBe(2);
    await expect(
      db.all(
        "SELECT target_id FROM alert_states WHERE target_type = 'monitor'",
      ),
    ).resolves.toEqual([{ target_id: redirectId }]);

    // Deleting the sole passkey when password and CF Access are disabled is blocked.
    await db.run(
      "INSERT INTO admin_passkeys (id, name, public_key, created_at) VALUES ('pk-1', 'YubiKey', 'AAAA', 1000)",
    );
    await db.run(
      "INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?1, 1000, 9999999999)",
      [await sha256Hex("test-sess")],
    );
    const passkeyOnlyApp = createApp(
      db,
      loadConfig({ PUBLIC_BASE_URL: "http://localhost:8787" }),
    );
    const lockoutAttempt = await passkeyOnlyApp.request(
      "/api/v1/admin/passkeys/pk-1",
      {
        method: "DELETE",
        headers: { Authorization: "Bearer test-sess" },
      },
    );

    expect(lockoutAttempt.status).toBe(400);
  });

  it("exposes strictly sanitized public status without leaking private targets or node internals", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-tok",
    });
    const app = createApp(db, config);
    const adminHeaders = {
      "Authorization": "Bearer admin-tok",
      "Content-Type": "application/json",
    };

    const pubNodeRes = await app.request("/api/v1/admin/nodes", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ id: "secret-edge-slug-01", label: "Edge Node" }),
    });
    const pubNode = await pubNodeRes.json<{ token: string }>();

    const privNodeRes = await app.request("/api/v1/admin/nodes", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ id: "private-core", label: "Core Router" }),
    });
    const privNode = await privNodeRes.json<{ token: string }>();

    await ingestNodeReport(
      db,
      config,
      {
        node_id: "secret-edge-slug-01",
        system: {
          uptime_secs: 7200,
          cpu_pct: 12.5,
          mem_used_bytes: 500,
          mem_total_bytes: 1000,
        },
        mounts: [
          {
            path: "/",
            used_bytes: 90,
            total_bytes: 100,
            status: "warn",
          },
          {
            path: "/srv/secret-nas",
            used_bytes: 250,
            total_bytes: 10_000,
            status: "ok",
          },
        ],
        checks: [
          {
            key: "internal_check",
            label: "Internal DB",
            status: "warn",
            detail: "secret-stack-trace",
          },
        ],
        series: [
          {
            key: "tcp.relay",
            label: "Edge Relay",
            unit: "ms",
            value: 45,
            status: "ok",
          },
        ],
        info: [{ key: "wan6", label: "WAN IPv6", value: "2001:db8:dead::1" }],
      },
      pubNode.token,
    );

    await ingestNodeReport(
      db,
      config,
      { node_id: "private-core", system: { uptime_secs: 900 } },
      privNode.token,
    );

    await upsertMonitor(db, {
      id: "pub-web",
      name: "Public Web",
      url: "https://internal-lb.corp:8443/secret-health",
      expected_body: "super-secret-body",
      is_public: true,
    });
    await upsertMonitor(db, {
      id: "priv-admin",
      name: "Internal Admin",
      url: "https://10.0.0.99/health",
      is_public: false,
    });

    vi.stubGlobal("fetch", (async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.55:8443");
    }) satisfies typeof fetch);
    await runTick(db, config);

    // Node defaults to private until explicitly enabled.
    const beforeToggle = await (
      await app.request("/api/v1/public/status")
    ).json<{ nodes: unknown[]; monitors: { name: string }[] }>();

    expect(beforeToggle.nodes).toHaveLength(0);
    expect(beforeToggle.monitors.map((m) => m.name)).toEqual(["Public Web"]);

    const patchRes = await app.request(
      "/api/v1/admin/nodes/secret-edge-slug-01",
      {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ is_public: true }),
      },
    );

    expect(patchRes.status).toBe(200);

    const pubRes = await app.request("/api/v1/public/status");
    const rawText = await pubRes.text();
    const parsed = JSON.parse(rawText) as {
      monitors: { name: string; status_detail: string | null }[];
      nodes: {
        label: string;
        overall_status: string;
        cpu_pct: number;
        mem_pct: number;
        storage_pct: number;
      }[];
    };

    expect(parsed.monitors).toMatchObject([
      { name: "Public Web", status_detail: "Unreachable" },
    ]);
    expect(parsed.nodes).toMatchObject([
      {
        label: "Edge Node",
        overall_status: "warn",
        cpu_pct: 12.5,
        mem_pct: 50,
        storage_pct: 3.4,
      },
    ]);

    // Switching primary_mount to "/" pins the summary to that specific mount.
    const pinRes = await app.request(
      "/api/v1/admin/nodes/secret-edge-slug-01",
      {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ primary_mount: "/" }),
      },
    );

    expect(pinRes.status).toBe(200);

    const pinnedPub = await (
      await app.request("/api/v1/public/status")
    ).json<{
      nodes: { storage_pct: number }[];
    }>();

    expect(pinnedPub.nodes[0].storage_pct).toBe(90);

    // Resetting primary_mount to null (or "sum") returns to combined sum.
    const sumRes = await app.request(
      "/api/v1/admin/nodes/secret-edge-slug-01",
      {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ primary_mount: null }),
      },
    );

    expect(sumRes.status).toBe(200);

    const summedPub = await (
      await app.request("/api/v1/public/status")
    ).json<{
      nodes: { storage_pct: number }[];
    }>();

    expect(summedPub.nodes[0].storage_pct).toBe(3.4);

    for (const secret of [
      "secret-edge-slug-01",
      "private-core",
      "Core Router",
      "/srv/secret-nas",
      "internal_check",
      "secret-stack-trace",
      "Edge Relay",
      "2001:db8:dead::1",
      "internal-lb.corp",
      "super-secret-body",
      "Internal Admin",
      "10.0.0.55",
      "10.0.0.99",
    ]) {
      expect(rawText).not.toContain(secret);
    }
  });

  it("tracks 30m, 6h, and 1d monitor uptime rollups across ticks", async () => {
    vi.useFakeTimers();
    const baseMs = Date.UTC(2026, 10, 20, 0, 10, 0);
    vi.setSystemTime(baseMs);

    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-rollup",
    });
    const app = createApp(db, config);

    await upsertMonitor(db, {
      id: "blog",
      name: "Blog",
      url: "https://blog.example.com",
      is_public: true,
    });

    let nextOk = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: nextOk ? 200 : 503 })),
    );

    // Day 1: 1 ok, 1 fail in the same 30m bucket.
    await runTick(db, config, { forceMonitors: true });
    vi.setSystemTime(baseMs + 5 * 60_000);
    nextOk = false;
    await runTick(db, config, { forceMonitors: true });

    // Day 2 (+24h): 1 ok in a new 30m / 6h / 1d bucket.
    vi.setSystemTime(baseMs + 86_400_000);
    nextOk = true;
    await runTick(db, config, { forceMonitors: true });

    const pubRes = await app.request("/api/v1/public/status");
    const pub = await pubRes.json<{
      monitors: {
        name: string;
        rollups: {
          m30: { ok: number; total: number }[];
          h6: { ok: number; total: number }[];
          d1: { ok: number; total: number }[];
        };
      }[];
    }>();

    expect(pub.monitors).toHaveLength(1);

    const { rollups } = pub.monitors[0];

    expect(rollups.d1).toHaveLength(2);
    expect(rollups.d1[0]).toMatchObject({ ok: 1, total: 2 });
    expect(rollups.d1[1]).toMatchObject({ ok: 1, total: 1 });
    expect(rollups.h6).toHaveLength(2);
    expect(rollups.m30.at(-1)).toMatchObject({ ok: 1, total: 1 });
  });

  it("reconciles hub nodes, monitors, order, settings, and prune via declarative sync", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-sync",
    });
    const app = createApp(db, config);
    async function adminRequest<T>(
      method: string,
      apiPath: string,
      body?: unknown,
    ): Promise<T> {
      const res = await app.request(apiPath, {
        method,
        headers: {
          Authorization: "Bearer admin-sync",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      expect(res.ok).toBeTruthy();

      return await res.json();
    }

    const nodeA = await adminRequest<{ token: string }>(
      "POST",
      "/api/v1/admin/nodes",
      { id: "alpha", label: "Alpha", is_public: false },
    );
    await adminRequest("POST", "/api/v1/admin/nodes", {
      id: "beta",
      label: "Beta",
      is_public: true,
    });
    await upsertMonitor(db, {
      id: "legacy",
      name: "Legacy",
      url: "https://legacy.example.com/",
    });
    await ingestNodeReport(
      db,
      config,
      {
        node_id: "alpha",
        monitors: [
          {
            key: "agent_mon",
            name: "Agent Managed",
            from: "hub",
            url: "https://agent.example.com/healthz",
          },
        ],
      },
      nodeA.token,
    );

    const spec = parseSyncSpec({
      hub_url: "https://status.example.com/",
      auto_register: true,
      nodes: [
        { id: "beta", is_public: false },
        { id: "alpha", is_public: true },
        { id: "not-yet-enrolled", is_public: false },
      ],
      monitors: [
        {
          id: "blog",
          name: "Blog",
          url: "https://blog.example.com",
          public_url: "https://blog.example.com",
          is_public: true,
        },
        {
          id: "vault",
          name: "Vault",
          url: "https://vault.example.com/alive",
          is_public: false,
          expected_body: "ok",
        },
      ],
    });

    const snap1 = await adminRequest<DashboardSnapshot>(
      "GET",
      "/api/v1/admin/snapshot",
    );
    const plan1 = computeSyncPlan(snap1, spec);

    expect(plan1.hasChanges).toBeTruthy();
    expect(plan1.hasConflicts).toBeFalsy();
    expect(plan1.settingsPatch).toEqual({ auto_register: true });
    expect(plan1.nodePatches).toEqual([
      {
        id: "beta",
        patch: { is_public: false },
        changes: ["is_public: true -> false"],
      },
      {
        id: "alpha",
        patch: { is_public: true },
        changes: ["is_public: false -> true"],
      },
    ]);
    expect(plan1.missingNodes).toEqual(["not-yet-enrolled"]);
    expect(plan1.nodeOrder).toEqual(["beta", "alpha"]);
    expect(plan1.monitorsCreate.map((m) => m.id)).toEqual(["blog", "vault"]);
    expect(plan1.unmanagedMonitors.map((m) => m.id)).toEqual(["legacy"]);
    expect(plan1.monitorsDelete).toEqual([]);

    await applySyncPlan(adminRequest, plan1);

    const snap2 = await adminRequest<DashboardSnapshot>(
      "GET",
      "/api/v1/admin/snapshot",
    );

    expect(snap2.settings.auto_register).toBeTruthy();
    expect(snap2.nodes.map((n) => [n.id, n.is_public])).toEqual([
      ["beta", false],
      ["alpha", true],
    ]);
    expect(snap2.monitors.map((m) => m.id)).toEqual([
      "blog",
      "vault",
      "legacy",
      "alpha:agent_mon",
    ]);

    const plan2 = computeSyncPlan(snap2, spec);

    expect(plan2.hasChanges).toBeFalsy();
    expect(plan2.unmanagedMonitors.map((m) => m.id)).toEqual(["legacy"]);

    const prunePlan = computeSyncPlan(snap2, spec, { prune: true });

    expect(prunePlan.hasChanges).toBeTruthy();
    expect(prunePlan.monitorsDelete.map((m) => m.id)).toEqual(["legacy"]);

    await applySyncPlan(adminRequest, prunePlan);

    const snap3 = await adminRequest<DashboardSnapshot>(
      "GET",
      "/api/v1/admin/snapshot",
    );

    expect(snap3.monitors.map((m) => m.id)).toEqual([
      "blog",
      "vault",
      "alpha:agent_mon",
    ]);
    expect(
      computeSyncPlan(snap3, spec, { prune: true }).hasChanges,
    ).toBeFalsy();

    const conflictSpec = parseSyncSpec({
      monitors: [
        {
          id: "alpha:agent_mon",
          name: "Conflict",
          url: "https://agent.example.com/healthz",
        },
      ],
    });
    const conflictPlan = computeSyncPlan(snap3, conflictSpec);

    expect(conflictPlan.hasConflicts).toBeTruthy();
    await expect(applySyncPlan(adminRequest, conflictPlan)).rejects.toThrow(
      /agent-managed conflicts/,
    );
  });

  it("tracks agent-probed http, tcp, and exec monitors with rollups, alerts, staleness, and public redaction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000 * 1000);

    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-agent-mon",
      FAILURE_THRESHOLD: "2",
    });
    const app = createApp(db, config);
    const adminHeaders = {
      "Authorization": "Bearer admin-agent-mon",
      "Content-Type": "application/json",
    };

    const nodeRes = await app.request("/api/v1/admin/nodes", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ id: "homelab", label: "Homelab" }),
    });
    const { token } = await nodeRes.json<{ token: string }>();

    // Reject hub-probed non-HTTP monitor spec.
    const badSpec = await app.request("/api/v1/ingest/report", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        node_id: "homelab",
        monitors: [
          {
            key: "bad",
            name: "Bad",
            type: "tcp",
            from: "hub",
            target: "127.0.0.1:5432",
          },
        ],
      }),
    });

    expect(badSpec.status).toBe(400);

    const report = (
      pgOk: boolean,
      caddyOk: boolean,
      caddyErr: string | null = null,
    ) =>
      app.request("/api/v1/ingest/report", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          node_id: "homelab",
          interval_secs: 60,
          grace_secs: 120,
          system: { uptime_secs: 1000 },
          monitors: [
            {
              key: "immich",
              name: "Immich",
              type: "http",
              from: "agent",
              target: "http://127.0.0.1:2283/api/server/ping",
              result: { ok: true, http_status: 200, latency_ms: 4.2 },
            },
            {
              key: "pg",
              name: "PostgreSQL",
              from: "agent",
              type: "tcp",
              target: "10.0.0.8:5432",
              is_public: true,
              result: pgOk
                ? { ok: true, latency_ms: 1.5 }
                : {
                    ok: false,
                    latency_ms: 3000,
                    error: "connection refused 10.0.0.8:5432",
                  },
            },
            {
              key: "caddy",
              name: "Caddy",
              from: "agent",
              type: "exec",
              target: "systemctl is-active caddy",
              is_public: true,
              result: caddyOk
                ? { ok: true }
                : { ok: false, error: caddyErr ?? "inactive" },
            },
          ],
        }),
      });

    expect((await report(true, true)).status).toBe(200);

    // Hub tick must not fetch agent-probed monitors when fresh.
    const fetchMock = vi.fn(
      async () => new Response("unexpected", { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const freshTick = await runTick(db, config, { forceMonitors: true });

    expect(freshTick.probed_monitors).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const snap1 = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    const immich = snap1.monitors.find((m) => m.id === "homelab:immich")!;
    const pg = snap1.monitors.find((m) => m.id === "homelab:pg")!;
    const caddy = snap1.monitors.find((m) => m.id === "homelab:caddy")!;

    expect(immich).toMatchObject({
      probe: {
        from: "agent",
        type: "http",
        target: "http://127.0.0.1:2283/api/server/ping",
        grace_secs: 120,
      },
      is_public: false,
      last_status: "ok",
      last_http_status: 200,
      last_latency_ms: 4.2,
    });
    expect(pg).toMatchObject({
      probe: {
        from: "agent",
        type: "tcp",
        target: "10.0.0.8:5432",
        grace_secs: 120,
      },
      is_public: true,
      last_status: "ok",
      last_latency_ms: 1.5,
    });
    expect(caddy).toMatchObject({
      probe: {
        from: "agent",
        type: "exec",
        target: "systemctl is-active caddy",
        grace_secs: 120,
      },
      is_public: true,
      last_status: "ok",
      last_latency_ms: null,
    });

    // Two consecutive exec failures open an incident and redact private details on public status.
    vi.setSystemTime(10_060 * 1000);
    await report(false, false, "secret stderr token");
    vi.setSystemTime(10_120 * 1000);
    await report(false, false, "secret stderr token");

    const pubRes = await app.request("/api/v1/public/status");
    const pubRaw = await pubRes.text();
    const pub = JSON.parse(pubRaw) as {
      monitors: {
        name: string;
        last_status: string;
        status_detail: string | null;
      }[];
    };

    expect(
      pub.monitors.map((m) => [m.name, m.last_status, m.status_detail]),
    ).toEqual([
      ["PostgreSQL", "fail", "Unreachable"],
      ["Caddy", "fail", "Failed"],
    ]);

    for (const secret of [
      "Immich",
      "127.0.0.1:2283",
      "10.0.0.8:5432",
      "systemctl",
      "secret stderr token",
    ]) {
      expect(pubRaw).not.toContain(secret);
    }

    // Recover before testing staleness.
    vi.setSystemTime(10_180 * 1000);
    await report(true, true);

    // Advance past interval (60s) + grace (120s) without any agent report -> Hub marks monitors stale.
    vi.setSystemTime((10_180 + 240) * 1000);
    await runTick(db, config);

    const snapStale = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();
    const stalePg = snapStale.monitors.find((m) => m.id === "homelab:pg")!;

    expect(stalePg.last_status).toBe("fail");
    expect(stalePg.last_checked_at).toBe(10_180);
    expect(stalePg.last_error).toContain("No report from homelab");
    expect(stalePg.samples.at(-1)?.ok).toBeFalsy();
    expect(
      snapStale.incidents.some(
        (inc) =>
          inc.incident_key === "monitor:homelab:pg" && inc.state === "open",
      ),
    ).toBeTruthy();

    // Agent returns and clears the stale incident.
    vi.setSystemTime((10_180 + 300) * 1000);
    await report(true, true);

    const snapRecovered = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    expect(
      snapRecovered.monitors.find((m) => m.id === "homelab:pg")!.last_status,
    ).toBe("ok");
    expect(
      snapRecovered.incidents.some((inc) => inc.target_type === "monitor"),
    ).toBeFalsy();

    // Hub can PATCH is_public and public_url on agent-managed monitor when agent omits is_public,
    // and subsequent agent reports preserve those hub-side display settings.
    const patchImmich = await app.request(
      "/api/v1/admin/monitors/homelab%3Aimmich",
      {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({
          is_public: true,
          public_url: "https://photos.example.com",
        }),
      },
    );

    expect(patchImmich.status).toBe(200);

    // Agent explicitly set is_public on pg -> Hub cannot override its visibility (409).
    const lockedPg = await app.request("/api/v1/admin/monitors/homelab%3Apg", {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ is_public: false }),
    });

    expect(lockedPg.status).toBe(409);

    // Next agent report does not wipe hub-edited is_public / public_url on immich.
    vi.setSystemTime((10_180 + 360) * 1000);
    await report(true, true);

    const snapAfterPatch = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();
    const immichAfter = snapAfterPatch.monitors.find(
      (m) => m.id === "homelab:immich",
    )!;
    const pgAfter = snapAfterPatch.monitors.find((m) => m.id === "homelab:pg")!;

    expect(immichAfter).toMatchObject({
      is_public: true,
      public_managed: false,
      public_url: "https://photos.example.com/",
    });
    expect(pgAfter.public_managed).toBeTruthy();

    // Declarative sync can override visibility/public_url/order for unmanaged-visibility agent monitors.
    const overrideSpec = parseSyncSpec({
      monitors: [
        {
          id: "homelab:immich",
          is_public: false,
          public_url: null,
        },
        {
          id: "homelab:pg",
        },
      ],
    });
    const overridePlan = computeSyncPlan(snapAfterPatch, overrideSpec);

    expect(overridePlan.hasConflicts).toBeFalsy();
    expect(overridePlan.monitorPatches).toEqual([
      {
        id: "homelab:immich",
        patch: { is_public: false, public_url: null },
        changes: [
          "is_public: true -> false",
          'public_url: "https://photos.example.com/" -> null',
        ],
      },
    ]);
  });

  it("supports hub-managed groups on nodes and monitors across admin, public status, agent reports, and sync", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-tok",
    });
    const app = createApp(db, config);
    const adminHeaders = {
      "Authorization": "Bearer admin-tok",
      "Content-Type": "application/json",
    };

    const nodeRes = await app.request("/api/v1/admin/nodes", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        id: "homelab",
        label: "Homelab",
        group: "  Homelab  ",
        is_public: true,
      }),
    });

    expect(nodeRes.status).toBe(201);

    const { token } = await nodeRes.json<{ token: string }>();

    // Report an agent-managed monitor and verify node group is preserved.
    await ingestNodeReport(
      db,
      config,
      {
        node_id: "homelab",
        label: "Homelab",
        system: { uptime_secs: 1200 },
        monitors: [
          {
            key: "yanqi",
            name: "Yanqi",
            from: "agent",
            type: "exec",
            is_public: true,
            result: { ok: true },
          },
        ],
      },
      token,
    );

    // Hub-managed monitor created with group, plus private monitor in private-only group.
    await upsertMonitor(db, {
      id: "blog",
      name: "Blog",
      group: "Sites",
      url: "https://blog.example.com",
      is_public: true,
    });
    await upsertMonitor(db, {
      id: "vault",
      name: "Vault",
      group: "Internal",
      url: "https://vault.example.com",
      is_public: false,
    });

    // PATCH group on agent-managed monitor even when is_public is agent-managed.
    const patchAgentMon = await app.request(
      "/api/v1/admin/monitors/homelab%3Ayanqi",
      {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ group: "Homelab" }),
      },
    );

    expect(patchAgentMon.status).toBe(200);

    // Subsequent agent report (even changing monitor name) must preserve hub-set groups.
    await ingestNodeReport(
      db,
      config,
      {
        node_id: "homelab",
        label: "Homelab",
        system: { uptime_secs: 1260 },
        monitors: [
          {
            key: "yanqi",
            name: "Yanqi Bot",
            from: "agent",
            type: "exec",
            is_public: true,
            result: { ok: true },
          },
        ],
      },
      token,
    );

    const snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    expect(snap.nodes.find((n) => n.id === "homelab")?.group).toBe("Homelab");
    expect(snap.monitors.find((m) => m.id === "blog")?.group).toBe("Sites");
    expect(snap.monitors.find((m) => m.id === "homelab:yanqi")?.group).toBe(
      "Homelab",
    );

    // Public status exposes groups for public items only (private-only group does not appear).
    const pub = await (
      await app.request("/api/v1/public/status")
    ).json<{
      nodes: { label: string; group: string | null }[];
      monitors: { name: string; group: string | null }[];
    }>();

    expect(pub.nodes).toEqual([
      expect.objectContaining({ label: "Homelab", group: "Homelab" }),
    ]);
    expect(pub.monitors.map((m) => ({ name: m.name, group: m.group }))).toEqual(
      [
        { name: "Yanqi Bot", group: "Homelab" },
        { name: "Blog", group: "Sites" },
      ],
    );

    // Declarative sync reconciles group on nodes, hub monitors, and agent monitor overrides.
    const spec = parseSyncSpec({
      nodes: [{ id: "homelab", group: "Home" }],
      monitors: [
        {
          id: "blog",
          name: "Blog",
          group: "Public",
          url: "https://blog.example.com",
          is_public: true,
        },
        { id: "homelab:yanqi", group: null },
      ],
    });
    const plan = computeSyncPlan(snap, spec);

    expect(plan.hasConflicts).toBeFalsy();
    expect(plan.nodePatches).toEqual([
      {
        id: "homelab",
        patch: { group: "Home" },
        changes: ['group: "Homelab" -> "Home"'],
      },
    ]);
    expect(plan.monitorsUpdate).toHaveLength(1);
    expect(plan.monitorsUpdate[0].changes).toEqual([
      'group: "Sites" -> "Public"',
    ]);
    expect(plan.monitorPatches).toEqual([
      {
        id: "homelab:yanqi",
        patch: { group: null },
        changes: ['group: "Homelab" -> null'],
      },
    ]);

    await applySyncPlan(async (method, apiPath, body) => {
      const res = await app.request(apiPath, {
        method,
        headers: adminHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      expect(res.ok).toBeTruthy();

      return await res.json();
    }, plan);

    const snapAfterSync = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    expect(snapAfterSync.nodes.find((n) => n.id === "homelab")?.group).toBe(
      "Home",
    );
    expect(snapAfterSync.monitors.find((m) => m.id === "blog")?.group).toBe(
      "Public",
    );
    expect(
      snapAfterSync.monitors.find((m) => m.id === "homelab:yanqi")?.group,
    ).toBeNull();
  });

  it("serves 6h node sparklines from embedded nodes.spark_json without reading node_samples", async () => {
    vi.useFakeTimers();
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-tok",
    });
    const app = createApp(db, config);
    const adminHeaders = {
      "Authorization": "Bearer admin-tok",
      "Content-Type": "application/json",
    };

    const nodeRes = await app.request("/api/v1/admin/nodes", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ id: "edge", label: "Edge", is_public: true }),
    });
    const { token } = await nodeRes.json<{ token: string }>();

    // Two reports in the same 450s bucket (t=900, 960) and one in the next bucket (t=1400).
    for (const [ts, cpu, ping, loss] of [
      [900, 10, 40, 0],
      [960, 20, 60, 25],
      [1400, 30, 50, 0],
    ] as const) {
      vi.setSystemTime(ts * 1000);
      await ingestNodeReport(
        db,
        config,
        {
          node_id: "edge",
          label: "Edge",
          system: {
            uptime_secs: ts,
            cpu_pct: cpu,
            mem_used_bytes: 500,
            mem_total_bytes: 1000,
          },
          series: [
            {
              key: "tcp.relay",
              label: "Relay",
              unit: "ms",
              value: ping,
              loss_pct: loss,
              status: "ok",
            },
          ],
        },
        token,
      );
    }

    // Wipe node_samples to prove snapshots read exclusively from nodes.spark_json.
    await db.run("DELETE FROM node_samples");

    const snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();
    const edge = snap.nodes.find((n) => n.id === "edge")!;

    expect(edge.history._cpu).toEqual([
      { ts: 900, value: 15, aux: null },
      { ts: 1350, value: 30, aux: null },
    ]);
    expect(edge.history["tcp.relay"]).toEqual([
      { ts: 900, value: 50, aux: 25 },
      { ts: 1350, value: 50, aux: 0 },
    ]);

    const pub = await (
      await app.request("/api/v1/public/status")
    ).json<{
      nodes: { cpu_history: { ts: number; value: number }[] }[];
    }>();

    expect(pub.nodes[0].cpu_history).toEqual([
      { ts: 900, value: 15, aux: null },
      { ts: 1350, value: 30, aux: null },
    ]);
  });

  it("exposes strictly redacted public incidents and has_latency flags without leaking private targets or internal node checks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000 * 1000);
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-tok",
      FAILURE_THRESHOLD: "1",
    });
    const app = createApp(db, config);
    const adminHeaders = {
      "Authorization": "Bearer admin-tok",
      "Content-Type": "application/json",
    };

    const nodeRes = await app.request("/api/v1/admin/nodes", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        id: "secret-node-slug",
        label: "Public Edge",
        is_public: true,
        interval_secs: 60,
        grace_secs: 60,
      }),
    });
    const { token } = await nodeRes.json<{ token: string }>();

    // Report node with a failing internal check (must NEVER appear on public incidents)
    // and an agent exec monitor (has_latency must be false).
    await ingestNodeReport(
      db,
      config,
      {
        node_id: "secret-node-slug",
        label: "Public Edge",
        system: { uptime_secs: 1000 },
        checks: [
          {
            key: "db_secret",
            label: "Internal DB",
            status: "fail",
            summary: "password auth failed on 10.0.0.5",
          },
        ],
        monitors: [
          {
            key: "worker",
            name: "Queue Worker",
            from: "agent",
            type: "exec",
            is_public: true,
            result: { ok: true },
          },
        ],
      },
      token,
    );

    await upsertMonitor(db, {
      id: "pub-api",
      name: "Public API",
      url: "https://internal.corp:8443/health",
      is_public: true,
    });
    await upsertMonitor(db, {
      id: "priv-api",
      name: "Secret Admin",
      url: "https://10.0.0.9/admin",
      is_public: false,
    });

    // Fail both monitors with sensitive error text -> firing alert_events
    vi.stubGlobal("fetch", (async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.88:8443");
    }) satisfies typeof fetch);
    await runTick(db, config, { forceMonitors: true });

    // Recover both monitors 120s later -> paired resolved incident
    vi.setSystemTime(10_120 * 1000);
    vi.stubGlobal(
      "fetch",
      (async () => new Response("ok", { status: 200 })) satisfies typeof fetch,
    );
    await runTick(db, config, { forceMonitors: true });

    // Trigger an ongoing HTTP 502 on pub-api and let node go offline
    vi.setSystemTime(10_400 * 1000);
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response("bad gw", { status: 502 })) satisfies typeof fetch,
    );
    await runTick(db, config, { forceMonitors: true });

    const pubRes = await app.request("/api/v1/public/status");
    const raw = await pubRes.text();

    expect(raw).not.toContain("secret-node-slug");
    expect(raw).not.toContain("Secret Admin");
    expect(raw).not.toContain("Internal DB");
    expect(raw).not.toContain("10.0.0.88");
    expect(raw).not.toContain("10.0.0.5");

    const pub = JSON.parse(raw) as {
      monitors: { key: string; name: string; has_latency: boolean }[];
      nodes: { key: string; label: string }[];
      incidents: {
        key: string;
        target_key: string;
        target_type: string;
        name: string;
        state: string;
        started_at: number;
        resolved_at: number | null;
        reason: string;
      }[];
    };

    const apiMon = pub.monitors.find((m) => m.name === "Public API")!;
    const execMon = pub.monitors.find((m) => m.name === "Queue Worker")!;

    expect(apiMon.has_latency).toBeTruthy();
    expect(execMon.has_latency).toBeFalsy();

    expect(pub.incidents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_type: "node",
          target_key: pub.nodes[0].key,
          name: "Public Edge",
          state: "open",
          resolved_at: null,
          reason: "Offline",
        }),
        expect.objectContaining({
          target_type: "monitor",
          target_key: execMon.key,
          name: "Queue Worker",
          state: "open",
          resolved_at: null,
          reason: "Failed",
        }),
        expect.objectContaining({
          target_type: "monitor",
          target_key: apiMon.key,
          name: "Public API",
          state: "open",
          resolved_at: null,
          reason: "HTTP 502",
        }),
        expect.objectContaining({
          target_type: "monitor",
          target_key: apiMon.key,
          name: "Public API",
          state: "resolved",
          started_at: 10_000,
          resolved_at: 10_120,
          reason: "Unreachable",
        }),
      ]),
    );
    expect(pub.incidents).toHaveLength(4);
    expect(pub.incidents.at(-1)?.state).toBe("resolved");
  });

  it("persists status page title and links via settings PATCH, exposes them publicly, and reconciles via sync", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-tok",
    });
    const app = createApp(db, config);
    const adminHeaders = {
      "Authorization": "Bearer admin-tok",
      "Content-Type": "application/json",
    };

    const badLink = await app.request("/api/v1/admin/settings", {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({
        site_links: [{ label: "Bad", url: "javascript:alert(1)" }],
      }),
    });

    expect(badLink.status).toBe(400);

    const patchRes = await app.request("/api/v1/admin/settings", {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({
        site_title: "  Acme Status  ",
        site_links: [
          { label: "Homepage", url: "https://example.com" },
          { label: "Docs", url: "https://docs.example.com" },
        ],
      }),
    });

    expect(patchRes.status).toBe(200);

    const pub = await (
      await app.request("/api/v1/public/status")
    ).json<{
      site_title: string | null;
      site_links: { label: string; url: string }[];
    }>();

    expect(pub.site_title).toBe("Acme Status");
    expect(pub.site_links).toEqual([
      { label: "Homepage", url: "https://example.com/" },
      { label: "Docs", url: "https://docs.example.com/" },
    ]);

    const snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();
    const spec = parseSyncSpec({
      site_title: null,
      site_links: [{ label: "Blog", url: "https://blog.example.com" }],
    });
    const plan = computeSyncPlan(snap, spec);

    expect(plan.settingsPatch).toEqual({
      site_title: null,
      site_links: [{ label: "Blog", url: "https://blog.example.com/" }],
    });

    await applySyncPlan(async (method, apiPath, body) => {
      const res = await app.request(apiPath, {
        method,
        headers: adminHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      expect(res.ok).toBeTruthy();

      return await res.json();
    }, plan);

    const pubAfter = await (
      await app.request("/api/v1/public/status")
    ).json<{
      site_title: string | null;
      site_links: { label: string; url: string }[];
    }>();

    expect(pubAfter.site_title).toBeNull();
    expect(pubAfter.site_links).toEqual([
      { label: "Blog", url: "https://blog.example.com/" },
    ]);
  });

  it("supports scheduled maintenances with alert suppression, public redaction, and declarative sync", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000 * 1000);
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-tok",
      FAILURE_THRESHOLD: "1",
    });
    const app = createApp(db, config);
    const adminHeaders = {
      "Authorization": "Bearer admin-tok",
      "Content-Type": "application/json",
    };

    await upsertMonitor(db, {
      id: "pub-web",
      name: "Public Web",
      url: "https://web.example.com",
      is_public: true,
    });
    await upsertMonitor(db, {
      id: "priv-db",
      name: "Secret DB",
      url: "https://10.0.0.2/health",
      is_public: false,
    });

    // Reject window shorter than 60s
    const badRes = await app.request("/api/v1/admin/maintenances", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        title: "Too short",
        starts_at: 20_000,
        ends_at: 20_010,
      }),
    });

    expect(badRes.status).toBe(400);

    // Active maintenance covering both a public and private monitor
    const activeRes = await app.request("/api/v1/admin/maintenances", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        id: "upgrade-1",
        title: "Storage Upgrade",
        body: "Brief restarts expected.",
        starts_at: 19_900,
        ends_at: 20_900,
        targets: [
          { type: "monitor", id: "pub-web" },
          { type: "monitor", id: "priv-db" },
        ],
      }),
    });

    expect(activeRes.status).toBe(200);

    // Private-only maintenance must never leak to public status
    await app.request("/api/v1/admin/maintenances", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        id: "priv-only",
        title: "Internal Secret Maintenance",
        starts_at: 20_500,
        ends_at: 21_500,
        targets: [{ type: "monitor", id: "priv-db" }],
      }),
    });

    // Failing probes during active maintenance must suppress notifications while recording muted history
    const fetchedUrls: string[] = [];
    vi.stubGlobal("fetch", (async (input) => {
      fetchedUrls.push(String(input));

      return new Response("err", { status: 503 });
    }) satisfies typeof fetch);
    await runTick(db, config, { forceMonitors: true });

    const snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    expect(fetchedUrls.some((u) => u.includes("telegram"))).toBeFalsy();
    expect(snap.events).toHaveLength(2);
    expect(
      snap.events.every((e) => e.delivery.status === "muted"),
    ).toBeTruthy();
    expect(snap.maintenances).toHaveLength(2);

    const pubRes = await app.request("/api/v1/public/status");
    const raw = await pubRes.text();

    expect(raw).not.toContain("Internal Secret Maintenance");
    expect(raw).not.toContain("Secret DB");
    expect(raw).not.toContain("priv-db");

    const pub = JSON.parse(raw) as {
      maintenances: {
        title: string;
        state: string;
        targets: string[];
      }[];
    };

    expect(pub.maintenances).toEqual([
      expect.objectContaining({
        title: "Storage Upgrade",
        state: "active",
        targets: ["Public Web"],
      }),
    ]);

    // Declarative sync updates existing maintenance and prunes undeclared ones
    const spec = parseSyncSpec({
      maintenances: [
        {
          id: "upgrade-1",
          title: "Storage Upgrade v2",
          starts_at: 19_900,
          ends_at: 21_200,
          targets: [],
        },
      ],
    });
    const plan = computeSyncPlan(snap, spec, { prune: true });

    expect(plan.maintenancesUpdate).toHaveLength(1);
    expect(plan.maintenancesDelete).toEqual([
      { id: "priv-only", title: "Internal Secret Maintenance" },
    ]);

    await applySyncPlan(async (method, apiPath, body) => {
      const res = await app.request(apiPath, {
        method,
        headers: adminHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      expect(res.ok).toBeTruthy();

      return await res.json();
    }, plan);

    const snapAfter = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    expect(snapAfter.maintenances).toHaveLength(1);
    expect(snapAfter.maintenances[0]).toMatchObject({
      id: "upgrade-1",
      title: "Storage Upgrade v2",
      ends_at: 21_200,
      targets: [],
    });
  });

  it("derives passkey rpID from the request host, reverse proxy origin, or loopback", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-tok",
    });
    const app = createApp(db, config);
    await db.run(
      "INSERT INTO admin_passkeys (id, name, public_key, created_at) VALUES ('cred-1', 'Key', 'AAAA', 1000)",
    );

    // Custom domain hitting Worker directly even when PUBLIC_BASE_URL is a placeholder.
    const customDomain = await app.request(
      "https://status.custom.dev/api/v1/auth/passkey/login/options",
      { method: "POST" },
    );

    expect(customDomain.status).toBe(200);
    await expect(customDomain.json()).resolves.toMatchObject({
      options: { rpId: "status.custom.dev" },
    });

    // Loopback behind a reverse proxy for PUBLIC_BASE_URL.
    const proxied = await app.request(
      "http://127.0.0.1:8787/api/v1/auth/passkey/login/options",
      {
        method: "POST",
        headers: { Origin: "https://status.example.com" },
      },
    );

    expect(proxied.status).toBe(200);
    await expect(proxied.json()).resolves.toMatchObject({
      options: { rpId: "status.example.com" },
    });

    // Direct local development on localhost ignores untrusted external Origin headers.
    const localDev = await app.request(
      "http://localhost:8787/api/v1/auth/passkey/login/options",
      {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      },
    );

    expect(localDev.status).toBe(200);
    await expect(localDev.json()).resolves.toMatchObject({
      options: { rpId: "localhost" },
    });
  });

  it("delivers signed webhook notifications with custom headers", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-tok",
      WEBHOOK_URL: "https://hooks.example.com/uptarn",
      WEBHOOK_SECRET: "whsec-test-secret",
      WEBHOOK_HEADERS: JSON.stringify({
        "Authorization": "Bearer hook-token",
        "X-Custom": "uptarn",
      }),
    });
    const app = createApp(db, config);

    const snapRes = await app.request("/api/v1/admin/snapshot", {
      headers: { Authorization: "Bearer admin-tok" },
    });

    expect(snapRes.status).toBe(200);
    await expect(snapRes.json()).resolves.toMatchObject({
      settings: {
        channels: { telegram: false, matrix: false, webhook: true },
      },
    });

    const delivered: {
      url: string;
      method?: string;
      headers: Record<string, string>;
      body: string;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      (input: string | URL | Request, init?: RequestInit) => {
        delivered.push({
          url: String(input),
          method: init?.method,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: String(init?.body ?? ""),
        });

        return Promise.resolve(new Response("ok", { status: 200 }));
      },
    );

    const testRes = await app.request("/api/v1/admin/notifications/test", {
      method: "POST",
      headers: { Authorization: "Bearer admin-tok" },
    });

    expect(testRes.status).toBe(200);
    await expect(testRes.json()).resolves.toEqual({
      ok: true,
      delivery: { webhook: "ok" },
    });

    expect(delivered).toHaveLength(1);

    const req = delivered[0];

    expect(req.url).toBe("https://hooks.example.com/uptarn");
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe("Bearer hook-token");
    expect(req.headers["x-custom"]).toBe("uptarn");
    expect(req.headers["x-uptarn-event"]).toBe("alert.resolved");
    expect(req.headers["x-uptarn-signature-256"]).toBe(
      `sha256=${await hmacSha256Hex("whsec-test-secret", req.body)}`,
    );
    expect(JSON.parse(req.body)).toMatchObject({
      event: "alert.resolved",
      kind: "resolved",
      title: "Uptarn test notification",
      url: "https://status.example.com/admin/monitors",
      alerts: [
        {
          kind: "resolved",
          target_type: "monitor",
          target_id: "test",
          label: "Uptarn test notification",
        },
      ],
    });
  });

  it("rejects oversized ingest payloads with HTTP 413", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-tok",
      AUTO_REGISTER: "true",
      ENROLLMENT_TOKEN: "enroll-tok",
    });
    const app = createApp(db, config);

    const oversizedReport = JSON.stringify({
      node_id: "big-node",
      label: "x".repeat(260 * 1024),
    });
    const reportRes = await app.request("/api/v1/ingest/report", {
      method: "POST",
      headers: {
        "Authorization": "Bearer enroll-tok",
        "Content-Type": "application/json",
      },
      body: oversizedReport,
    });

    expect(reportRes.status).toBe(413);

    const removedJobIngest = await app.request("/api/v1/ingest/job", {
      method: "POST",
      headers: {
        "Authorization": "Bearer admin-tok",
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(removedJobIngest.status).toBe(404);
  });

  it("tracks monthly node traffic across reports, reboots, reset day changes, and cycle rollovers", async () => {
    vi.useFakeTimers();
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-tok",
      AUTO_REGISTER: "true",
      ENROLLMENT_TOKEN: "enroll-tok",
    });
    const app = createApp(db, config);

    const postReport = (rx: number, tx: number) =>
      ingestNodeReport(
        db,
        config,
        {
          node_id: "vps-jp",
          label: "VPS JP",
          system: { uptime_secs: 3600, rx_bytes: rx, tx_bytes: tx },
        },
        "enroll-tok",
      );

    async function getNode() {
      const res = await app.request("/api/v1/admin/snapshot", {
        headers: { Authorization: "Bearer admin-tok" },
      });
      const snap = await res.json<DashboardSnapshot>();

      return snap.nodes.find((n) => n.id === "vps-jp")!;
    }

    // Baseline report on March 10 sets starting counter without counting pre-Uptarn bytes.
    vi.setSystemTime(new Date("2026-03-10T10:00:00Z"));
    await postReport(10_000, 5000);

    await expect(getNode()).resolves.toMatchObject({
      month_rx_bytes: 0,
      month_tx_bytes: 0,
      traffic_reset_day: 1,
    });

    // Normal delta accumulation.
    vi.setSystemTime(new Date("2026-03-10T10:01:00Z"));
    await postReport(12_500, 6200);

    await expect(getNode()).resolves.toMatchObject({
      month_rx_bytes: 2500,
      month_tx_bytes: 1200,
    });

    // Host reboot resets kernel counters below prev_rx/tx; post-reboot bytes are added cleanly.
    vi.setSystemTime(new Date("2026-03-10T10:05:00Z"));
    await postReport(800, 400);

    await expect(getNode()).resolves.toMatchObject({
      month_rx_bytes: 3300,
      month_tx_bytes: 1600,
    });

    // Update reset day to 15 via PATCH (preserves current cycle counters).
    const patchRes = await app.request("/api/v1/admin/nodes/vps-jp", {
      method: "PATCH",
      headers: {
        "Authorization": "Bearer admin-tok",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ traffic_reset_day: 15 }),
    });

    expect(patchRes.status).toBe(200);
    await expect(getNode()).resolves.toMatchObject({
      month_rx_bytes: 3300,
      month_tx_bytes: 1600,
      traffic_reset_day: 15,
    });

    // Crossing March 15 00:00 UTC rolls counters over to 0 immediately in snapshot and on ingest.
    vi.setSystemTime(new Date("2026-03-15T00:01:00Z"));

    await expect(getNode()).resolves.toMatchObject({
      month_rx_bytes: 0,
      month_tx_bytes: 0,
      traffic_reset_day: 15,
    });

    await postReport(1000, 500);
    vi.setSystemTime(new Date("2026-03-15T00:02:00Z"));
    await postReport(1600, 900);

    await expect(getNode()).resolves.toMatchObject({
      month_rx_bytes: 600,
      month_tx_bytes: 400,
    });

    // Declarative sync reconciles traffic_reset_day.
    const snapRes = await app.request("/api/v1/admin/snapshot", {
      headers: { Authorization: "Bearer admin-tok" },
    });
    const snapBeforeSync = await snapRes.json<DashboardSnapshot>();
    const plan = computeSyncPlan(
      snapBeforeSync,
      parseSyncSpec({ nodes: [{ id: "vps-jp", traffic_reset_day: 20 }] }),
    );

    expect(plan.nodePatches).toHaveLength(1);
    expect(plan.nodePatches[0].patch).toEqual({ traffic_reset_day: 20 });
  });

  it("enforces optional Turnstile siteverify on password login when configured", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_PASSWORD: "correct-horse-battery",
      TURNSTILE_SITE_KEY: "0x4AAAAAAA-test-sitekey",
      TURNSTILE_SECRET: "0x4AAAAAAA-test-secret",
    });
    const app = createApp(db, config);

    // Public status exposes only the sitekey, never the secret.
    const pubRes = await app.request("/api/v1/public/status");

    expect(pubRes.status).toBe(200);

    const pubText = await pubRes.text();

    expect(pubText).toContain("0x4AAAAAAA-test-sitekey");
    expect(pubText).not.toContain("0x4AAAAAAA-test-secret");

    const login = (token?: string) =>
      app.request("https://status.example.com/api/v1/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.10",
        },
        body: JSON.stringify({
          password: "correct-horse-battery",
          ...(token === undefined ? {} : { "cf-turnstile-response": token }),
        }),
      });

    // Missing token is rejected before touching siteverify or password.
    expect((await login()).status).toBe(403);

    // Action mismatch and hostname mismatch are rejected (fail closed).
    const calls: string[] = [];
    let nextResponse: Response = Response.json(
      {
        success: true,
        action: "signup",
        hostname: "status.example.com",
      },
      { status: 200 },
    );
    vi.stubGlobal(
      "fetch",
      (_input: string | URL | Request, init?: RequestInit) => {
        calls.push(String(init?.body ?? ""));

        return Promise.resolve(nextResponse.clone());
      },
    );

    expect((await login("tok-wrong-action")).status).toBe(403);

    nextResponse = Response.json(
      {
        success: true,
        action: "login",
        hostname: "evil.example",
      },
      { status: 200 },
    );

    expect((await login("tok-wrong-host")).status).toBe(403);

    nextResponse = new Response("upstream error", { status: 500 });

    expect((await login("tok-upstream-500")).status).toBe(403);

    nextResponse = Response.json(
      {
        success: true,
        action: "login",
        hostname: "status.example.com",
      },
      { status: 200 },
    );
    const okRes = await login("tok-valid");

    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("Set-Cookie")).toContain("uptarn_session=");

    const lastBody = new URLSearchParams(calls.at(-1));

    expect(lastBody.get("secret")).toBe("0x4AAAAAAA-test-secret");
    expect(lastBody.get("response")).toBe("tok-valid");
    expect(lastBody.get("remoteip")).toBe("203.0.113.10");
  });

  it("buffers 3s live telemetry with rate limiting, reboot-safe bps, and strict public redaction", () => {
    expect(parseLiveIngestFrame("not-json")).toBeNull();
    expect(parseLiveIngestFrame(JSON.stringify({ cpu_pct: 10 }))).toBeNull();
    expect(parseLiveIngestFrame("x".repeat(5000))).toBeNull();

    const f1 = parseLiveIngestFrame(
      JSON.stringify({
        uptime_secs: 1000,
        cpu_pct: 12.34,
        load_1m: 0.456,
        mem_used_bytes: 512,
        mem_total_bytes: 1024,
        rx_bytes: 10_000,
        tx_bytes: 5000,
      }),
    );

    expect(f1).toEqual({
      uptime_secs: 1000,
      cpu_pct: 12.3,
      load_1m: 0.46,
      mem_used_bytes: 512,
      mem_total_bytes: 1024,
      rx_bytes: 10_000,
      tx_bytes: 5000,
    });

    const buf = new LiveStateBuffer();
    const t1 = buf.ingest("web-1", "n_aaaa1111", true, f1!, 1000);

    expect(t1?.admin).toMatchObject({
      node_id: "web-1",
      cpu_pct: 12.3,
      rx_bps: null,
      tx_bps: null,
    });
    expect(t1?.pub).toEqual({
      key: "n_aaaa1111",
      ts: 1000,
      uptime_secs: 1000,
      cpu_pct: 12.3,
      mem_pct: 50,
    });

    // Sub-1s duplicate frame is ignored.
    expect(buf.ingest("web-1", "n_aaaa1111", true, f1!, 1000)).toBeNull();

    // 3s later computes accurate bps.
    const t2 = buf.ingest(
      "web-1",
      "n_aaaa1111",
      true,
      { ...f1!, rx_bytes: 13_000, tx_bytes: 6500 },
      1003,
    );

    expect(t2?.admin.rx_bps).toBe(1000);
    expect(t2?.admin.tx_bps).toBe(500);

    // Private node is never included in public payloads.
    const priv = buf.ingest("priv-1", "n_bbbb2222", false, f1!, 1003);

    expect(priv?.pub).toBeNull();
    expect(Object.keys(buf.publicInitPayload(1003).nodes)).toEqual([
      "n_aaaa1111",
    ]);
    expect(Object.keys(buf.adminInitPayload(1003).nodes)).toEqual([
      "web-1",
      "priv-1",
    ]);

    // Toggling visibility immediately hides node from public init.
    buf.setNodeVisibility("web-1", "n_aaaa1111", false);

    expect(buf.publicInitPayload(1003).nodes).toEqual({});
  });

  it("supports push jobs with pending->overdue alerts, /ping start/ok/fail, rotation, and collector-managed jobs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "admin-tok",
      AUTO_REGISTER: "true",
      ENROLLMENT_TOKEN: "enroll-tok",
    });
    const app = createApp(db, config);
    const adminHeaders = {
      "Authorization": "Bearer admin-tok",
      "Content-Type": "application/json",
    };

    // 1. Create a push job -> immediately exists as pending
    const createRes = await app.request("/api/v1/admin/jobs", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        key: "db-backup",
        label: "DB Backup",
        interval_secs: 3600,
        grace_secs: 300,
      }),
    });

    expect(createRes.status).toBe(201);

    const created = await createRes.json<{
      key: string;
      token: string;
      ping_url: string;
    }>();

    expect(created.key).toBe("db-backup");
    expect(created.token).toMatch(/^uptn_job_/);

    let snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    expect(snap.jobs).toHaveLength(1);
    expect(snap.jobs[0]).toMatchObject({
      key: "db-backup",
      managed_by_node_id: null,
      overall_status: "pending",
      last_status: "pending",
      last_run_at: null,
    });

    // 2. If never reported past interval + grace, runTick fires overdue incident
    vi.advanceTimersByTime(4000 * 1000);
    await runTick(db, config);
    snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    expect(snap.jobs[0].overall_status).toBe("overdue");
    expect(
      snap.incidents.some((i) => i.incident_key === "job:db-backup"),
    ).toBeTruthy();

    // 3. /ping/:token/start -> running, then /ping/:token -> ok with auto duration & resolves incident
    const startRes = await app.request(`/ping/${created.token}/start`, {
      method: "POST",
    });

    expect(startRes.status).toBe(200);

    vi.advanceTimersByTime(12 * 1000);
    const okRes = await app.request(`/ping/${created.token}`, {
      method: "POST",
      body: "uploaded 42 MiB",
    });

    expect(okRes.status).toBe(200);

    snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    expect(snap.jobs[0]).toMatchObject({
      overall_status: "ok",
      last_status: "ok",
      last_duration_ms: 12_000,
      last_summary: "uploaded 42 MiB",
      last_detail: null,
    });
    expect(
      snap.incidents.some((i) => i.incident_key === "job:db-backup"),
    ).toBeFalsy();

    // 4. /ping/:token/fail -> fail with tail detail + incident
    const failRes = await app.request(`/ping/${created.token}/fail`, {
      method: "POST",
      body: "step 1 ok\nfatal: disk full",
    });

    expect(failRes.status).toBe(200);

    snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    expect(snap.jobs[0]).toMatchObject({
      overall_status: "fail",
      last_summary: "fatal: disk full",
      last_detail: "step 1 ok\nfatal: disk full",
    });

    // 5. Rotate token invalidates old token
    const rotateRes = await app.request(
      "/api/v1/admin/jobs/db-backup/rotate-token",
      { method: "POST", headers: adminHeaders },
    );

    expect(rotateRes.status).toBe(200);

    const oldPing = await app.request(`/ping/${created.token}`, {
      method: "GET",
    });

    expect(oldPing.status).toBe(404);

    // 6. Collector-managed jobs synced via node report (namespaced, read-only on hub, pruned when removed)
    const nowSecs = Math.floor(Date.now() / 1000);
    await ingestNodeReport(
      db,
      config,
      {
        node_id: "homelab",
        label: "Homelab",
        jobs: [
          {
            key: "restic",
            label: "Restic Backup",
            schedule: "Daily 03:00",
            status: "ok",
            last_run_at: nowSecs - 600,
            next_run_at: nowSecs + 85_800,
            duration_ms: 9500,
            summary: "snapshot ok",
          },
        ],
      },
      "enroll-tok",
    );

    snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();
    const agentJob = snap.jobs.find((j) => j.key === "homelab:restic");

    expect(agentJob).toMatchObject({
      node_id: "homelab",
      managed_by_node_id: "homelab",
      schedule: "Daily 03:00",
      interval_secs: null,
      overall_status: "ok",
      next_due_at: nowSecs + 85_800,
    });

    // Hub tick does NOT mark agent collector jobs overdue; collector owns health status.
    vi.advanceTimersByTime(200_000 * 1000);
    await runTick(db, config);
    snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    expect(
      snap.jobs.find((j) => j.key === "homelab:restic")?.overall_status,
    ).toBe("ok");

    // Hub cannot mutate or delete agent-managed jobs
    const patchAgent = await app.request(
      "/api/v1/admin/jobs/homelab%3Arestic",
      {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ label: "Nope" }),
      },
    );

    expect(patchAgent.status).toBe(409);

    const delAgent = await app.request("/api/v1/admin/jobs/homelab%3Arestic", {
      method: "DELETE",
      headers: adminHeaders,
    });

    expect(delAgent.status).toBe(409);

    // Removing job from collector report prunes it cleanly
    await ingestNodeReport(
      db,
      config,
      { node_id: "homelab", label: "Homelab", jobs: [] },
      "enroll-tok",
    );
    snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    expect(snap.jobs.some((j) => j.key === "homelab:restic")).toBeFalsy();
  });

  it("acknowledges active incidents, records muted outage history, and pairs events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T00:00:00Z"));
    const config = loadConfig({
      PUBLIC_BASE_URL: "http://localhost:8787",
      ADMIN_TOKEN: "admin-tok",
      FAILURE_THRESHOLD: "1",
    });
    const app = createApp(db, config);
    const adminHeaders = {
      "Authorization": "Bearer admin-tok",
      "Content-Type": "application/json",
    };

    await upsertMonitor(db, {
      id: "api",
      name: "API",
      url: "https://api.example.com/health",
    });

    // Fail monitor -> opens incident
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );
    await runTick(db, config, { forceMonitors: true });

    let snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    expect(snap.incidents).toHaveLength(1);
    expect(snap.incidents[0].incident_key).toBe("monitor:api");
    expect(snap.incidents[0].acknowledged_at).toBeNull();

    // Acknowledge active incident -> persists across another failing tick
    const ackRes = await app.request("/api/v1/admin/incidents/ack", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ incident_key: "monitor:api", acknowledged: true }),
    });

    expect(ackRes.status).toBe(200);

    const ackBody = await ackRes.json<{ acknowledged_at: number }>();

    expect(ackBody.acknowledged_at).toBeTypeOf("number");

    vi.advanceTimersByTime(65_000);
    await runTick(db, config, { forceMonitors: true });
    snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    expect(snap.incidents[0].acknowledged_at).toBe(ackBody.acknowledged_at);

    // Unacknowledge works
    const unackRes = await app.request("/api/v1/admin/incidents/ack", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        incident_key: "monitor:api",
        acknowledged: false,
      }),
    });

    expect(unackRes.status).toBe(200);

    snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    expect(snap.incidents[0].acknowledged_at).toBeNull();

    // Re-ack then recover -> deletes alert_state and pairs history with duration
    await app.request("/api/v1/admin/incidents/ack", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ incident_key: "monitor:api", acknowledged: true }),
    });
    vi.advanceTimersByTime(120_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    await runTick(db, config, { forceMonitors: true });

    snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    expect(snap.incidents).toHaveLength(0);

    // Now mute monitor and trigger a muted outage -> should still record history with status: "muted"
    await app.request("/api/v1/admin/mute", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        target_type: "monitor",
        target_id: "api",
        duration_secs: 3600,
      }),
    });

    vi.advanceTimersByTime(65_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("err", { status: 500 })),
    );
    await runTick(db, config, { forceMonitors: true });

    vi.advanceTimersByTime(180_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    await runTick(db, config, { forceMonitors: true });

    snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: adminHeaders })
    ).json<DashboardSnapshot>();

    const history = pairIncidentEvents(snap.events);

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      incident_key: "monitor:api",
      state: "resolved",
      duration_secs: 180,
      firing_delivery: { status: "muted" },
      resolved_delivery: { status: "muted" },
    });
    expect(history[1]).toMatchObject({
      incident_key: "monitor:api",
      state: "resolved",
      duration_secs: 185,
    });
  });

  it("supports manual incident reports with editable timeline updates, auto-incident notes, and public redaction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T00:00:00Z"));
    const config = loadConfig({
      PUBLIC_BASE_URL: "http://localhost:8787",
      ADMIN_TOKEN: "admin-tok",
      FAILURE_THRESHOLD: "1",
    });
    const app = createApp(db, config);
    const adminHeaders = {
      "Authorization": "Bearer admin-tok",
      "Content-Type": "application/json",
    };

    await upsertMonitor(db, {
      id: "pub-web",
      name: "Public Web",
      url: "https://web.example.com",
      is_public: true,
    });
    await upsertMonitor(db, {
      id: "priv-db",
      name: "Secret DB",
      url: "https://10.0.0.5/health",
      is_public: false,
    });

    // 1. Trigger failing probe -> add public & private timeline notes -> edit public note
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("err", { status: 503 })),
    );
    await runTick(db, config, { forceMonitors: true });

    const pubNoteRes = await app.request("/api/v1/admin/incident-notes", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        incident_key: "monitor:pub-web",
        status: "investigating",
        message: "Initial draft note.",
        is_public: true,
      }),
    });

    expect(pubNoteRes.status).toBe(201);

    const { note: pubNote } = await pubNoteRes.json<{
      note: { id: string };
    }>();

    const editNoteRes = await app.request(
      `/api/v1/admin/incident-notes/${encodeURIComponent(pubNote.id)}`,
      {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({
          message: "Investigating upstream CDN 503s.",
        }),
      },
    );

    expect(editNoteRes.status).toBe(200);

    await app.request("/api/v1/admin/incident-notes", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        incident_key: "monitor:pub-web",
        message: "Internal-only debug hint",
        is_public: false,
      }),
    });

    // 2. Post public manual incident targeting both public & private monitors
    const postRes = await app.request("/api/v1/admin/incident-reports", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        id: "cdn-outage",
        title: "Upstream CDN disruption",
        status: "investigating",
        impact: "major",
        is_public: true,
        message: "Seeing elevated 503s from edge PoP.",
        targets: [
          { type: "monitor", id: "pub-web" },
          { type: "monitor", id: "priv-db" },
        ],
      }),
    });

    expect(postRes.status).toBe(201);

    // 3. Post private-only & private-target-only incidents (must NOT leak publicly)
    await app.request("/api/v1/admin/incident-reports", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        id: "internal-only",
        title: "Internal secret outage",
        is_public: false,
        message: "Internal note",
      }),
    });
    await app.request("/api/v1/admin/incident-reports", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        id: "priv-target-only",
        title: "Secret DB failover",
        is_public: true,
        targets: [{ type: "monitor", id: "priv-db" }],
      }),
    });

    // 4. Append plain update (no status change), edit it, then add resolved update, then delete the plain one
    vi.advanceTimersByTime(300_000);
    const plainUpdRes = await app.request(
      "/api/v1/admin/incident-reports/cdn-outage/updates",
      {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          message: "Temporary note to edit and delete",
        }),
      },
    );

    expect(plainUpdRes.status).toBe(200);

    const plainBody = await plainUpdRes.json<{
      report: {
        status: string;
        updates: { id: string; message: string; status: string | null }[];
      };
    }>();

    expect(plainBody.report.status).toBe("investigating");

    const tempId = plainBody.report.updates[1].id;

    const patchUpdRes = await app.request(
      `/api/v1/admin/incident-reports/cdn-outage/updates/${encodeURIComponent(tempId)}`,
      {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ message: "Edited note" }),
      },
    );

    expect(patchUpdRes.status).toBe(200);

    const delUpdRes = await app.request(
      `/api/v1/admin/incident-reports/cdn-outage/updates/${encodeURIComponent(tempId)}`,
      { method: "DELETE", headers: adminHeaders },
    );

    expect(delUpdRes.status).toBe(200);

    vi.advanceTimersByTime(300_000);
    const resolveRes = await app.request(
      "/api/v1/admin/incident-reports/cdn-outage/updates",
      {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          status: "resolved",
          message: "Traffic rerouted and 503s cleared.",
        }),
      },
    );

    expect(resolveRes.status).toBe(200);

    const pubRes = await app.request("/api/v1/public/status");
    const raw = await pubRes.text();

    expect(raw).not.toContain("Internal-only debug hint");
    expect(raw).not.toContain("Internal secret outage");
    expect(raw).not.toContain("Secret DB failover");
    expect(raw).not.toContain("Secret DB");
    expect(raw).not.toContain("priv-db");

    const pub = JSON.parse(raw) as {
      incidents: { name: string; notes?: { message: string }[] }[];
      incident_reports: {
        title: string;
        status: string;
        targets: string[];
        updates: { status: string | null; message: string }[];
        resolved_at: number | null;
      }[];
    };

    expect(pub.incidents[0].name).toBe("Public Web");
    expect(pub.incidents[0].notes?.map((n) => n.message)).toEqual([
      "Investigating upstream CDN 503s.",
    ]);
    expect(pub.incident_reports).toHaveLength(1);
    expect(pub.incident_reports[0]).toMatchObject({
      title: "Upstream CDN disruption",
      status: "resolved",
      targets: ["Public Web"],
    });
    expect(pub.incident_reports[0].updates).toHaveLength(2);
    expect(pub.incident_reports[0].resolved_at).toBeTypeOf("number");

    // 5. Delete note & report
    const delNoteRes = await app.request(
      `/api/v1/admin/incident-notes/${encodeURIComponent(pubNote.id)}`,
      { method: "DELETE", headers: adminHeaders },
    );

    expect(delNoteRes.status).toBe(200);

    const delRes = await app.request(
      "/api/v1/admin/incident-reports/cdn-outage",
      { method: "DELETE", headers: adminHeaders },
    );

    expect(delRes.status).toBe(200);
  });
});
