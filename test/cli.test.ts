import { createMemoryTerminal } from "clerc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.ts";
import { createCli } from "../src/cli/cli.ts";
import { loadConfig } from "../src/config.ts";
import type { NodeDatabase } from "../src/db/node.ts";
import { applyMigrations, openNodeSqlite } from "../src/db/node.ts";
import {
  ingestJobReport,
  ingestNodeReport,
  runTick,
} from "../src/domain/index.ts";
import type {
  AdminSettingsSummary,
  JobSummary,
  MonitorSummary,
  NodeSummary,
} from "../src/shared/index.ts";

const SERVER_URL = "http://hub.local";
const ADMIN_TOKEN = "cli-admin-secret";

describe("uptarn CLI commands", () => {
  let db: NodeDatabase;
  let app: ReturnType<typeof createApp>;
  let config: ReturnType<typeof loadConfig>;

  beforeEach(async () => {
    db = openNodeSqlite(":memory:");
    await applyMigrations(db);
    config = loadConfig({
      PUBLIC_BASE_URL: SERVER_URL,
      ADMIN_TOKEN,
    });
    app = createApp(db, config);
    vi.stubGlobal(
      "fetch",
      (input: string | URL | Request, init?: RequestInit) => {
        const rawUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const parsed = new URL(rawUrl);

        return app.request(`${parsed.pathname}${parsed.search}`, init);
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  async function runCli(args: string[]) {
    const terminal = createMemoryTerminal({
      env: {
        UPTARN_SERVER: SERVER_URL,
        UPTARN_ADMIN_TOKEN: ADMIN_TOKEN,
      },
    });
    await createCli().run(args, { terminal });

    return terminal;
  }

  it("manages HTTP monitors with add, ls, show, edit, order, and rm", async () => {
    const created = await runCli([
      "monitor",
      "add",
      "Blog",
      "https://blog.example.com/healthz",
      "--id",
      "blog",
      "--public-url",
      "https://blog.example.com",
      "--method",
      "HEAD",
      "--status-min",
      "200",
      "--status-max",
      "204",
      "--interval",
      "120",
      "--timeout",
      "5000",
      "--private",
      "--json",
    ]);

    expect(JSON.parse(created.stdoutText())).toEqual({ ok: true, id: "blog" });

    await runCli([
      "monitor",
      "add",
      "Docs",
      "https://docs.example.com",
      "--id",
      "docs",
    ]);

    const listed = await runCli(["monitor", "ls", "--json"]);
    const monitors = JSON.parse(listed.stdoutText()) as MonitorSummary[];

    expect(monitors.map((m) => m.id)).toEqual(["blog", "docs"]);
    expect(monitors[0]).toMatchObject({
      name: "Blog",
      probe: {
        from: "hub",
        type: "http",
        url: "https://blog.example.com/healthz",
        method: "HEAD",
        expected_status_min: 200,
        expected_status_max: 204,
        timeout_ms: 5000,
      },
      public_url: "https://blog.example.com/",
      interval_secs: 120,
      enabled: true,
      is_public: false,
    });

    await runCli([
      "monitor",
      "edit",
      "blog",
      "--name",
      "Main Blog",
      "--public",
      "on",
      "--enabled",
      "off",
      "--public-url",
      "",
    ]);

    const shown = await runCli(["monitor", "show", "blog", "--json"]);
    const edited = JSON.parse(shown.stdoutText()) as MonitorSummary;

    expect(edited).toMatchObject({
      id: "blog",
      name: "Main Blog",
      probe: {
        from: "hub",
        type: "http",
        url: "https://blog.example.com/healthz",
        method: "HEAD",
        timeout_ms: 5000,
      },
      public_url: null,
      interval_secs: 120,
      enabled: false,
      is_public: true,
    });

    const shownText = await runCli(["monitor", "show", "blog"]);

    expect(shownText.stdoutText()).toContain("Main Blog");
    expect(shownText.stdoutText()).toContain("paused");

    await runCli(["monitor", "order", "docs", "blog"]);
    const reordered = JSON.parse(
      (await runCli(["monitor", "ls", "--json"])).stdoutText(),
    ) as MonitorSummary[];

    expect(reordered.map((m) => m.id)).toEqual(["docs", "blog"]);

    await runCli(["monitor", "rm", "blog"]);
    const remaining = JSON.parse(
      (await runCli(["monitor", "ls", "--json"])).stdoutText(),
    ) as MonitorSummary[];

    expect(remaining.map((m) => m.id)).toEqual(["docs"]);
  });

  it("manages nodes with add, ls, show, disk, public, order, rotate, and rm", async () => {
    const addedA = JSON.parse(
      (
        await runCli(["node", "add", "alpha", "--label", "Alpha", "--json"])
      ).stdoutText(),
    ) as { id: string; token: string };
    await runCli(["node", "add", "beta", "--label", "Beta"]);

    await ingestNodeReport(
      db,
      config,
      {
        node_id: "alpha",
        label: "Alpha",
        system: {
          uptime_secs: 3600,
          cpu_pct: 12,
          mem_used_bytes: 2_000_000_000,
          mem_total_bytes: 8_000_000_000,
        },
        mounts: [
          {
            path: "/",
            label: "Root",
            used_bytes: 20_000_000_000,
            total_bytes: 100_000_000_000,
            status: "ok",
          },
          {
            path: "/data",
            label: "Data",
            used_bytes: 800_000_000_000,
            total_bytes: 1_000_000_000_000,
            status: "ok",
          },
        ],
      },
      addedA.token,
    );

    await runCli(["node", "public", "alpha", "on"]);
    await runCli(["node", "group", "alpha", "Cloud"]);
    await runCli(["node", "disk", "alpha", "/data"]);
    await runCli(["node", "order", "beta", "alpha"]);

    const nodes = JSON.parse(
      (await runCli(["node", "ls", "--json"])).stdoutText(),
    ) as NodeSummary[];

    expect(nodes.map((n) => n.id)).toEqual(["beta", "alpha"]);
    expect(nodes[1]).toMatchObject({
      group: "Cloud",
      is_public: true,
      primary_mount: "/data",
    });

    await runCli(["node", "group", "alpha", ""]);
    const ungroupedAlpha = JSON.parse(
      (await runCli(["node", "show", "alpha", "--json"])).stdoutText(),
    ) as NodeSummary;

    expect(ungroupedAlpha.group).toBeNull();

    const detail = await runCli(["node", "show", "alpha"]);

    expect(detail.stdoutText()).toContain("/data");
    expect(detail.stdoutText()).toContain("Root");

    await runCli(["node", "disk", "alpha", "sum"]);
    const afterSum = JSON.parse(
      (await runCli(["node", "show", "alpha", "--json"])).stdoutText(),
    ) as NodeSummary;

    expect(afterSum.primary_mount).toBeNull();

    const rotated = JSON.parse(
      (await runCli(["node", "rotate", "beta", "--json"])).stdoutText(),
    ) as { id: string; token: string };

    expect(rotated.id).toBe("beta");
    expect(rotated.token).toMatch(/^uptn_node_/);

    await runCli(["node", "rm", "beta"]);
    const finalNodes = JSON.parse(
      (await runCli(["node", "ls", "--json"])).stdoutText(),
    ) as NodeSummary[];

    expect(finalNodes.map((n) => n.id)).toEqual(["alpha"]);
  });

  it("manages jobs, incidents, mute/unmute, settings, and passkeys", async () => {
    const added = JSON.parse(
      (await runCli(["node", "add", "worker", "--json"])).stdoutText(),
    ) as { token: string };

    await ingestJobReport(
      db,
      config,
      {
        job_key: "nightly-backup",
        node_id: "worker",
        label: "Nightly Backup",
        interval_secs: 86_400,
        status: "fail",
        summary: "rsync exit 23",
      },
      added.token,
    );
    await runTick(db, config);

    const jobs = JSON.parse(
      (await runCli(["job", "ls", "--json"])).stdoutText(),
    ) as JobSummary[];

    expect(jobs).toHaveLength(1);
    expect(jobs[0].key).toBe("nightly-backup");

    const jobDetail = await runCli(["job", "show", "nightly-backup"]);

    expect(jobDetail.stdoutText()).toContain("Nightly Backup");
    expect(jobDetail.stdoutText()).toContain("rsync exit 23");

    const incidents = JSON.parse(
      (await runCli(["incident", "ls", "--json"])).stdoutText(),
    ) as { incidents: unknown[]; events: unknown[] };

    expect(incidents.incidents.length).toBeGreaterThanOrEqual(1);

    await runCli(["mute", "job", "nightly-backup", "-d", "600"]);
    const mutedJob = JSON.parse(
      (await runCli(["job", "show", "nightly-backup", "--json"])).stdoutText(),
    ) as JobSummary;

    expect(mutedJob.muted_until).toBeGreaterThan(0);

    await runCli(["unmute", "job", "nightly-backup"]);
    const unmutedJob = JSON.parse(
      (await runCli(["job", "show", "nightly-backup", "--json"])).stdoutText(),
    ) as JobSummary;

    expect(unmutedJob.muted_until).toBe(0);

    await runCli(["job", "rm", "nightly-backup"]);
    const remainingJobs = JSON.parse(
      (await runCli(["job", "ls", "--json"])).stdoutText(),
    ) as JobSummary[];

    expect(remainingJobs).toHaveLength(0);

    await runCli(["settings", "auto-register", "on"]);
    const rotated = JSON.parse(
      (await runCli(["settings", "rotate-enroll", "--json"])).stdoutText(),
    ) as { enrollment_token: string };

    expect(rotated.enrollment_token).toMatch(/^uptn_enroll_/);

    await runCli(["settings", "mute", "-d", "900"]);
    const settings = JSON.parse(
      (await runCli(["settings", "show", "--json"])).stdoutText(),
    ) as AdminSettingsSummary;

    expect(settings.auto_register).toBeTruthy();
    expect(settings.enrollment_token).toBe(rotated.enrollment_token);
    expect(settings.global_muted_until).toBeGreaterThan(0);

    await runCli(["settings", "mute", "-d", "0"]);
    const unmutedSettings = JSON.parse(
      (await runCli(["settings", "show", "--json"])).stdoutText(),
    ) as AdminSettingsSummary;

    expect(unmutedSettings.global_muted_until).toBe(0);

    const passkeys = JSON.parse(
      (await runCli(["passkey", "ls", "--json"])).stdoutText(),
    ) as unknown[];

    expect(passkeys).toEqual([]);

    const statusOut = await runCli(["status"]);

    expect(statusOut.stdoutText()).toContain("Uptarn Hub");
  });

  it("reports rule and validation failures through Clerc diagnostics", async () => {
    const missingTokenTerminal = createMemoryTerminal();
    const missingToken = await createCli().run(
      ["status", "--server", SERVER_URL],
      { terminal: missingTokenTerminal },
    );

    expect(missingToken.ok).toBeFalsy();
    expect(missingTokenTerminal.stderrText()).toContain(
      "one of '--token' or '--token-file' is required",
    );

    const conflictingTokenTerminal = createMemoryTerminal();
    const conflictingToken = await createCli().run(
      [
        "status",
        "--server",
        SERVER_URL,
        "--token",
        ADMIN_TOKEN,
        "--token-file",
        "/tmp/token",
      ],
      { terminal: conflictingTokenTerminal },
    );

    expect(conflictingToken.ok).toBeFalsy();
    expect(conflictingTokenTerminal.stderrText()).toContain(
      "options '--token' and '--token-file' cannot be used together",
    );

    const emptyEditTerminal = createMemoryTerminal({
      env: { UPTARN_SERVER: SERVER_URL, UPTARN_ADMIN_TOKEN: ADMIN_TOKEN },
    });
    const emptyEdit = await createCli().run(["monitor", "edit", "blog"], {
      terminal: emptyEditTerminal,
    });

    expect(emptyEdit.ok).toBeFalsy();
    expect(emptyEditTerminal.stderrText()).toContain("at least one of");

    const badRangeTerminal = createMemoryTerminal({
      env: { UPTARN_SERVER: SERVER_URL, UPTARN_ADMIN_TOKEN: ADMIN_TOKEN },
    });
    const badRange = await createCli().run(
      [
        "monitor",
        "add",
        "Test",
        "https://example.com",
        "--status-min",
        "300",
        "--status-max",
        "200",
      ],
      { terminal: badRangeTerminal },
    );

    expect(badRange.ok).toBeFalsy();
    expect(badRangeTerminal.stderrText()).toContain(
      "'--status-max' must be greater than or equal to '--status-min'",
    );
    expect(badRangeTerminal.stderrText()).toContain(
      "received status-min=300, status-max=200",
    );

    const outOfBoundsTerminal = createMemoryTerminal({
      env: { UPTARN_SERVER: SERVER_URL, UPTARN_ADMIN_TOKEN: ADMIN_TOKEN },
    });
    const outOfBounds = await createCli().run(
      ["monitor", "add", "Test", "https://example.com", "--status-min", "99"],
      { terminal: outOfBoundsTerminal },
    );

    expect(outOfBounds.ok).toBeFalsy();
    expect(outOfBoundsTerminal.stderrText()).toContain(
      "expected an integer between 100 and 599",
    );

    const dupOrderTerminal = createMemoryTerminal({
      env: { UPTARN_SERVER: SERVER_URL, UPTARN_ADMIN_TOKEN: ADMIN_TOKEN },
    });
    const dupOrder = await createCli().run(["node", "order", "a", "b", "a"], {
      terminal: dupOrderTerminal,
    });

    expect(dupOrder.ok).toBeFalsy();
    expect(dupOrderTerminal.stderrText()).toContain("duplicate value 'a'");

    // Verify maintenance CLI add / ls / rm
    await runCli([
      "maint",
      "add",
      "Kernel Patch",
      "--id",
      "patch-1",
      "--start",
      "2026-12-01T00:00:00Z",
      "--end",
      "2026-12-01T02:00:00Z",
      "--target",
      "node:alpha",
    ]);
    const maintList = JSON.parse(
      (await runCli(["maint", "--json"])).stdoutText(),
    ) as {
      id: string;
      title: string;
      targets: { type: string; id: string }[];
    }[];

    expect(maintList).toHaveLength(1);
    expect(maintList[0]).toMatchObject({
      id: "patch-1",
      title: "Kernel Patch",
      targets: [{ type: "node", id: "alpha" }],
    });

    await runCli(["maint", "rm", "patch-1"]);

    expect(
      JSON.parse((await runCli(["maint", "--json"])).stdoutText()),
    ).toEqual([]);

    // Verify default subcommand & alias dispatch (mon -> monitor ls)
    const defaultMon = await runCli(["mon", "--json"]);

    expect(JSON.parse(defaultMon.stdoutText())).toEqual([]);
  });
});
