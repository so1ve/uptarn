import {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import type { CloudflareWorkerEnv } from "../src/cloudflare.ts";
import worker from "../src/cloudflare.ts";

describe("uptarn Cloudflare Worker runtime", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      env.DB,
      (
        env as unknown as {
          TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
        }
      ).TEST_MIGRATIONS,
    );
  });

  it("serves healthz, enforces auth, and ingests extensible reports in D1", async () => {
    const testEnv: CloudflareWorkerEnv = {
      DB: env.DB,
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "cf-test-admin",
      AUTO_REGISTER: "true",
      ENROLLMENT_TOKEN: "cf-enroll-token",
    };

    const ctx1 = createExecutionContext();
    const health = await worker.fetch(
      new Request("https://status.example.com/healthz"),
      testEnv,
      ctx1,
    );
    await waitOnExecutionContext(ctx1);

    expect(health.status).toBe(200);
    await expect(health.text()).resolves.toBe("ok\n");

    const ctx2 = createExecutionContext();
    const unauth = await worker.fetch(
      new Request("https://status.example.com/api/v1/admin/snapshot"),
      testEnv,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);

    expect(unauth.status).toBe(401);

    const ctx3 = createExecutionContext();
    const ingest = await worker.fetch(
      new Request("https://status.example.com/api/v1/ingest/report", {
        method: "POST",
        headers: {
          "Authorization": "Bearer cf-enroll-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          node_id: "edge-sg-01",
          label: "Edge SG",
          system: {
            uptime_secs: 42_000,
            cpu_pct: 6.5,
            mem_used_bytes: 256_000_000,
            mem_total_bytes: 1_073_741_824,
          },
          series: [
            {
              key: "tcp.relay",
              label: "Relay 443",
              unit: "ms",
              value: 58.4,
              loss_pct: 0,
              status: "ok",
            },
          ],
        }),
      }),
      testEnv,
      ctx3,
    );
    await waitOnExecutionContext(ctx3);

    expect(ingest.status).toBe(200);

    const ctx4 = createExecutionContext();
    const snapRes = await worker.fetch(
      new Request("https://status.example.com/api/v1/admin/snapshot", {
        headers: { Authorization: "Bearer cf-test-admin" },
      }),
      testEnv,
      ctx4,
    );
    await waitOnExecutionContext(ctx4);

    expect(snapRes.status).toBe(200);

    const snap = await snapRes.json<{ nodes: { id: string }[] }>();

    expect(snap.nodes.map((n) => n.id)).toContain("edge-sg-01");
  });

  it("caches unauthenticated public status and boot at the edge while bypassing for admin", async () => {
    const testEnv: CloudflareWorkerEnv = {
      DB: env.DB,
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "cf-test-admin",
    };

    async function run(request: Request) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, testEnv, ctx);
      await waitOnExecutionContext(ctx);

      return response;
    }

    const status1 = await run(
      new Request("https://status.example.com/api/v1/public/status"),
    );

    expect(status1.status).toBe(200);
    expect(status1.headers.get("Cache-Control")).toContain("s-maxage=15");

    const firstNow = (await status1.json<{ now: number }>()).now;

    // Update site_title via admin settings; within cache TTL the cached edge response is returned.
    const patchRes = await run(
      new Request("https://status.example.com/api/v1/admin/settings", {
        method: "PATCH",
        headers: {
          "Authorization": "Bearer cf-test-admin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ site_title: "Edge Cached Check" }),
      }),
    );

    expect(patchRes.status).toBe(200);

    const status2 = await run(
      new Request("https://status.example.com/api/v1/public/status?bust=1"),
    );

    expect(status2.status).toBe(200);
    await expect(status2.json()).resolves.toMatchObject({
      now: firstNow,
      site_title: null,
    });

    // Unauthenticated boot is cached as public, while authenticated boot bypasses cache.
    const pubBoot = await run(
      new Request("https://status.example.com/api/v1/boot"),
    );

    expect(pubBoot.status).toBe(200);
    await expect(pubBoot.json()).resolves.toMatchObject({ mode: "public" });

    const adminBoot = await run(
      new Request("https://status.example.com/api/v1/boot", {
        headers: { Authorization: "Bearer cf-test-admin" },
      }),
    );

    expect(adminBoot.status).toBe(200);
    await expect(adminBoot.json()).resolves.toMatchObject({
      mode: "admin",
      snapshot: { settings: { site_title: "Edge Cached Check" } },
    });
  });

  it("streams live 3s telemetry through LiveHub Durable Object with auth and public redaction", async () => {
    const testEnv: CloudflareWorkerEnv = {
      DB: env.DB,
      LIVE_HUB: (env as unknown as CloudflareWorkerEnv).LIVE_HUB,
      PUBLIC_BASE_URL: "https://status.example.com",
      ADMIN_TOKEN: "cf-test-admin",
      AUTO_REGISTER: "true",
      ENROLLMENT_TOKEN: "cf-enroll-token",
    };

    async function run(request: Request) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, testEnv, ctx);
      await waitOnExecutionContext(ctx);

      return response;
    }

    // Create one public node and one private node.
    const pubNode = await (
      await run(
        new Request("https://status.example.com/api/v1/admin/nodes", {
          method: "POST",
          headers: {
            "Authorization": "Bearer cf-test-admin",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ id: "live-pub", is_public: true }),
        }),
      )
    ).json<{ token: string }>();

    // Bad token is rejected before touching DO.
    const badUpgrade = await run(
      new Request(
        "https://status.example.com/api/v1/ingest/live?node_id=live-pub",
        {
          headers: {
            Upgrade: "websocket",
            Authorization: "Bearer wrong-token",
          },
        },
      ),
    );

    expect(badUpgrade.status).toBe(401);

    type CfSocket = Parameters<DurableObjectState["acceptWebSocket"]>[0];
    const socketOf = (res: Response) =>
      (res as Response & { webSocket?: CfSocket }).webSocket;
    const nextMessage = (ws: CfSocket) =>
      new Promise<string>((resolve) => {
        ws.addEventListener("message", (ev) => resolve(String(ev.data)), {
          once: true,
        });
      });

    // Connect admin viewer and public viewer.
    const adminResp = await run(
      new Request("https://status.example.com/api/v1/live", {
        headers: {
          Upgrade: "websocket",
          Authorization: "Bearer cf-test-admin",
        },
      }),
    );

    expect(adminResp.status).toBe(101);

    const adminWs = socketOf(adminResp);
    const adminInitPromise = nextMessage(adminWs);
    adminWs.accept();

    expect(JSON.parse(await adminInitPromise)).toMatchObject({ type: "init" });

    const pubResp = await run(
      new Request("https://status.example.com/api/v1/live", {
        headers: { Upgrade: "websocket" },
      }),
    );

    expect(pubResp.status).toBe(101);

    const pubWs = socketOf(pubResp);
    const pubInitPromise = nextMessage(pubWs);
    pubWs.accept();

    expect(JSON.parse(await pubInitPromise)).toMatchObject({ type: "init" });

    // Ping/pong auto-response works without waking DO.
    const pongPromise = nextMessage(pubWs);
    pubWs.send("ping");

    await expect(pongPromise).resolves.toBe("pong");

    // Connect agent and push a live telemetry frame.
    const agentResp = await run(
      new Request(
        "https://status.example.com/api/v1/ingest/live?node_id=live-pub",
        {
          headers: {
            Upgrade: "websocket",
            Authorization: `Bearer ${pubNode.token}`,
          },
        },
      ),
    );

    expect(agentResp.status).toBe(101);

    const agentWs = socketOf(agentResp);
    agentWs.accept();

    const adminTickPromise = nextMessage(adminWs);
    const pubTickPromise = nextMessage(pubWs);
    agentWs.send(
      JSON.stringify({
        uptime_secs: 9999,
        cpu_pct: 23.4,
        load_1m: 0.75,
        mem_used_bytes: 500,
        mem_total_bytes: 1000,
        rx_bytes: 50_000,
        tx_bytes: 25_000,
      }),
    );

    const adminTick = JSON.parse(await adminTickPromise) as {
      type: string;
      sample: Record<string, unknown>;
    };

    expect(adminTick).toMatchObject({
      type: "tick",
      sample: {
        node_id: "live-pub",
        cpu_pct: 23.4,
        load_1m: 0.75,
      },
    });

    const pubTick = JSON.parse(await pubTickPromise) as {
      type: string;
      sample: Record<string, unknown>;
    };

    expect(pubTick.type).toBe("tick");
    expect(pubTick.sample.cpu_pct).toBe(23.4);
    expect(pubTick.sample.mem_pct).toBe(50);
    expect(pubTick.sample).not.toHaveProperty("node_id");
    expect(pubTick.sample).not.toHaveProperty("load_1m");
    expect(pubTick.sample).not.toHaveProperty("rx_bps");

    agentWs.close();
    adminWs.close();
    pubWs.close();
  });
});
