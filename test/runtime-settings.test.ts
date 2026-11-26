import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.ts";
import { hmacSha256Hex } from "../src/auth/index.ts";
import { loadConfig } from "../src/config.ts";
import type { NodeDatabase } from "../src/db/node.ts";
import { applyMigrations, openNodeSqlite } from "../src/db/node.ts";
import { runTick, upsertMonitor } from "../src/domain/index.ts";
import type { DashboardSnapshot } from "../src/shared/index.ts";
import { unixNow } from "../src/shared/index.ts";

const ADMIN_TOKEN = "settings-test-token";
const authHeaders = {
  "Authorization": `Bearer ${ADMIN_TOKEN}`,
  "Content-Type": "application/json",
};

describe("runtime settings migration (policies & notification channels)", () => {
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

  it("overrides failure_threshold and retention_days from DB and falls back to env on reset", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN,
      FAILURE_THRESHOLD: "3",
      RETENTION_DAYS: "14",
    });
    const app = createApp(db, config);

    // Defaults come from env.
    const snap0 = await (
      await app.request("/api/v1/admin/snapshot", { headers: authHeaders })
    ).json<DashboardSnapshot>();

    expect(snap0.settings.failure_threshold).toBe(3);
    expect(snap0.settings.retention_days).toBe(14);

    // Update both via Web UI settings endpoint.
    const patchRes = await app.request("/api/v1/admin/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ failure_threshold: 1, retention_days: 2 }),
    });

    expect(patchRes.status).toBe(200);
    await expect(patchRes.json()).resolves.toMatchObject({
      ok: true,
      failure_threshold: 1,
      retention_days: 2,
    });

    // Insert an old alert event (5 days old) and a failing hub monitor.
    const now = unixNow();
    await db.run(
      `INSERT INTO alert_events
       (incident_key, target_type, target_id, label, kind, summary, created_at, delivery_json)
       VALUES (?1, 'monitor', 'm1', 'Monitor: m1', 'firing', 'old', ?2, '{}')`,
      ["monitor:m1:old", now - 5 * 86_400],
    );
    await upsertMonitor(db, {
      id: "m-fail",
      name: "Flaky",
      group: null,
      url: "https://down.example.com/health",
      public_url: null,
      method: "GET",
      expected_status_min: 200,
      expected_status_max: 299,
      expected_body: null,
      timeout_ms: 2000,
      interval_secs: 60,
      enabled: true,
      is_public: true,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("down", { status: 503 }))),
    );

    const tick = await runTick(db, config, { forceMonitors: true });

    expect(tick.pruned).toBeTruthy();

    // With DB failure_threshold = 1, a single failure opens the incident immediately.
    const states = await db.all<{ incident_key: string; state: string }>(
      "SELECT incident_key, state FROM alert_states WHERE incident_key = 'monitor:m-fail'",
    );

    expect(states).toEqual([{ incident_key: "monitor:m-fail", state: "open" }]);

    // With DB retention_days = 2, the 5-day-old event was pruned.
    const oldEvents = await db.all<{ incident_key: string }>(
      "SELECT incident_key FROM alert_events WHERE incident_key = 'monitor:m1:old'",
    );

    expect(oldEvents).toEqual([]);

    // Passing null clears DB overrides and falls back to env defaults.
    const resetRes = await app.request("/api/v1/admin/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ failure_threshold: null, retention_days: null }),
    });

    expect(resetRes.status).toBe(200);
    await expect(resetRes.json()).resolves.toMatchObject({
      failure_threshold: 3,
      retention_days: 14,
    });

    // Out-of-range values are rejected.
    const badRes = await app.request("/api/v1/admin/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ failure_threshold: 11 }),
    });

    expect(badRes.status).toBe(400);
  });

  it("configures notification channels in DB without echoing secrets and delivers tests", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN,
    });
    const app = createApp(db, config);

    // Enabling an incomplete channel fails with 400.
    const incompleteRes = await app.request("/api/v1/admin/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        notifications: {
          telegram: { enabled: true, chat_id: "-1001" },
        },
      }),
    });

    expect(incompleteRes.status).toBe(400);

    // Configure Telegram, Matrix, and Webhook completely in DB.
    const saveRes = await app.request("/api/v1/admin/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        notifications: {
          telegram: {
            enabled: true,
            chat_id: "-100999",
            bot_token: "12345:super-secret-tg",
          },
          matrix: {
            enabled: true,
            homeserver: "https://matrix.example.org/",
            room_id: "!ops:example.org",
            access_token: "syt_super_secret_mx",
          },
          webhook: {
            enabled: true,
            url: "https://hooks.example.com/uptarn",
            secret: "whsec_super_secret",
            headers: { "X-Team": "infra" },
          },
        },
      }),
    });

    expect(saveRes.status).toBe(200);

    const saveText = await saveRes.text();

    expect(saveText).not.toContain("12345:super-secret-tg");
    expect(saveText).not.toContain("syt_super_secret_mx");
    expect(saveText).not.toContain("whsec_super_secret");

    const snap = await (
      await app.request("/api/v1/admin/snapshot", { headers: authHeaders })
    ).json<DashboardSnapshot>();
    const snapText = JSON.stringify(snap);

    expect(snapText).not.toContain("12345:super-secret-tg");
    expect(snapText).not.toContain("syt_super_secret_mx");
    expect(snapText).not.toContain("whsec_super_secret");
    expect(snap.settings.channels).toEqual({
      telegram: true,
      matrix: true,
      webhook: true,
    });
    expect(snap.settings.notifications).toEqual({
      telegram: {
        enabled: true,
        configured: true,
        chat_id: "-100999",
        bot_token_source: "db",
      },
      matrix: {
        enabled: true,
        configured: true,
        homeserver: "https://matrix.example.org",
        room_id: "!ops:example.org",
        access_token_source: "db",
      },
      webhook: {
        enabled: true,
        configured: true,
        url: "https://hooks.example.com/uptarn",
        headers: { "X-Team": "infra" },
        secret_source: "db",
      },
    });

    // Updating non-secret field while omitting secret keeps the saved DB secret intact.
    const editRes = await app.request("/api/v1/admin/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        notifications: {
          telegram: { enabled: true, chat_id: "-100888" },
        },
      }),
    });

    expect(editRes.status).toBe(200);

    // Send a targeted test to webhook and verify custom header + HMAC signature.
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });

        return Promise.resolve(new Response("ok", { status: 200 }));
      }),
    );

    const whTest = await app.request("/api/v1/admin/notifications/test", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ channel: "webhook" }),
    });

    expect(whTest.status).toBe(200);
    await expect(whTest.json()).resolves.toEqual({
      ok: true,
      delivery: { webhook: "ok" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://hooks.example.com/uptarn");

    const whHeaders = new Headers(calls[0].init?.headers);

    expect(whHeaders.get("X-Team")).toBe("infra");

    const whBody = String(calls[0].init?.body ?? "");

    expect(whHeaders.get("X-Uptarn-Signature-256")).toBe(
      `sha256=${await hmacSha256Hex("whsec_super_secret", whBody)}`,
    );

    // Send an all-channels test with no body and verify all 3 fire with updated chat_id.
    calls.length = 0;
    const allTest = await app.request("/api/v1/admin/notifications/test", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(allTest.status).toBe(200);
    await expect(allTest.json()).resolves.toEqual({
      ok: true,
      delivery: { telegram: "ok", matrix: "ok", webhook: "ok" },
    });
    expect(calls).toHaveLength(3);

    const tgCall = calls.find((c) => c.url.includes("api.telegram.org"));

    expect(tgCall?.url).toContain("bot12345:super-secret-tg");
    expect(JSON.parse(String(tgCall?.init?.body))).toMatchObject({
      chat_id: "-100888",
    });
  });

  it("allows disabling env channels and clearing DB secret override back to env", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN,
      TELEGRAM_BOT_TOKEN: "env-bot-token",
      TELEGRAM_CHAT_ID: "-100env",
    });
    const app = createApp(db, config);

    // Disable env channel via Web UI toggle.
    const offRes = await app.request("/api/v1/admin/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        notifications: { telegram: { enabled: false } },
      }),
    });

    expect(offRes.status).toBe(200);
    await expect(offRes.json()).resolves.toMatchObject({
      channels: { telegram: false, matrix: false, webhook: false },
      notifications: {
        telegram: {
          enabled: false,
          configured: true,
          chat_id: "-100env",
          bot_token_source: "env",
        },
      },
    });

    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response("ok", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const mutedTest = await app.request("/api/v1/admin/notifications/test", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    await expect(mutedTest.json()).resolves.toEqual({
      ok: true,
      delivery: { status: "no_channels_configured" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    // Override token in DB, then clear DB token to fall back to env.
    await app.request("/api/v1/admin/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        notifications: {
          telegram: { enabled: true, bot_token: "db-bot-token" },
        },
      }),
    });

    const clearRes = await app.request("/api/v1/admin/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        notifications: {
          telegram: { bot_token: null },
        },
      }),
    });

    expect(clearRes.status).toBe(200);
    await expect(clearRes.json()).resolves.toMatchObject({
      notifications: {
        telegram: {
          enabled: true,
          configured: true,
          bot_token_source: "env",
        },
      },
    });
  });
});
