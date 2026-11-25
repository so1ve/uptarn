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
    expect(status1.headers.get("Cache-Control")).toContain("s-maxage=10");

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
});
