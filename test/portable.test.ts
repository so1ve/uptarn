import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.ts";
import { sha256Hex } from "../src/auth/index.ts";
import {
  applySyncPlan,
  computeSyncPlan,
  parseSyncSpec,
} from "../src/cli/sync.ts";
import { loadConfig } from "../src/config.ts";
import type { NodeDatabase } from "../src/db/node.ts";
import { applyMigrations, openNodeSqlite } from "../src/db/node.ts";
import {
  ingestJobReport,
  ingestNodeReport,
  runTick,
  upsertMonitor,
} from "../src/domain/index.ts";
import type { DashboardSnapshot } from "../src/shared/index.ts";

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
    await ingestJobReport(
      db,
      config,
      {
        job_key: "homelab-restic",
        node_id: "homelab",
        label: "Restic Backup",
        interval_secs: 3600,
        grace_secs: 600,
        status: "ok",
        duration_ms: 14_200,
        summary: "snapshot a1b2c3d saved",
      },
      "enroll-tok",
    );

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
});
