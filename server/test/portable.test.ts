import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.ts";
import { sha256Hex } from "../src/auth/index.ts";
import { loadConfig } from "../src/config.ts";
import type { NodeDatabase } from "../src/db/node.ts";
import { applyMigrations, openNodeSqlite } from "../src/db/node.ts";
import {
  ingestJobReport,
  ingestNodeReport,
  runTick,
  upsertMonitor,
} from "../src/domain/index.ts";

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
    expect(sentRequests[0].body).toContain("/nodes/homelab");

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

    await expect(
      db.first<{ expected_status_min: number; expected_status_max: number }>(
        "SELECT expected_status_min, expected_status_max FROM monitors WHERE id = ?1",
        [redirectId],
      ),
    ).resolves.toEqual({
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
        storage_pct: 90,
      },
    ]);

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
});
