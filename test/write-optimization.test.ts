import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";
import type { SqlDatabase, SqlStatement } from "../src/db/index.ts";
import type { NodeDatabase } from "../src/db/node.ts";
import { applyMigrations, openNodeSqlite } from "../src/db/node.ts";
import { createNode, ingestNodeReport } from "../src/domain/index.ts";
import type { NodeReportPayload } from "../src/shared/index.ts";

function traceWrites(inner: SqlDatabase) {
  const writes: string[] = [];
  const db: SqlDatabase = {
    all: (sql, params) => inner.all(sql, params),
    first: (sql, params) => inner.first(sql, params),
    run: (sql, params) => {
      writes.push(sql);

      return inner.run(sql, params);
    },
    allBatch: (stmts) => inner.allBatch(stmts),
    batch: (stmts: readonly SqlStatement[]) => {
      for (const s of stmts) {
        writes.push(s.sql);
      }

      return inner.batch(stmts);
    },
  };

  return { db, writes };
}

describe("D1 write-volume optimizations", () => {
  let inner: NodeDatabase;

  beforeEach(async () => {
    inner = openNodeSqlite(":memory:");
    await applyMigrations(inner);
  });

  afterEach(() => {
    inner.close();
  });

  it("skips unchanged managed jobs, open alert_states, and unchanged node index columns", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://status.example.com",
      FAILURE_THRESHOLD: "1",
    });
    const { token } = await createNode(inner, {
      id: "homelab",
      label: "Homelab",
      group: null,
      interval_secs: 60,
      grace_secs: 120,
      is_public: false,
    });

    const baseReport: NodeReportPayload = {
      node_id: "homelab",
      label: "Homelab",
      interval_secs: 60,
      grace_secs: 120,
      system: { uptime_secs: 1000, cpu_pct: 5, load_1m: 0.2 },
      checks: [
        {
          key: "systemd",
          label: "systemd",
          status: "fail",
          summary: "1 failed unit",
        },
      ],
      jobs: [
        {
          key: "restic",
          label: "Restic backup",
          schedule: "daily",
          status: "ok",
          last_run_at: 1_700_000_000,
          next_run_at: 1_700_086_400,
          duration_ms: 4200,
          summary: "snapshot ok",
          detail: null,
        },
      ],
    };

    const { db, writes } = traceWrites(inner);

    // First report creates the managed job and opens the failing check alert.
    await ingestNodeReport(db, config, baseReport, token);

    expect(writes.some((sql) => sql.includes("INSERT INTO jobs"))).toBeTruthy();
    expect(
      writes.some((sql) => sql.includes("INSERT INTO alert_states")),
    ).toBeTruthy();

    // Second identical report should:
    // 1. Update nodes without rewriting indexed label/is_public columns
    // 2. Skip writing to jobs completely
    // 3. Skip rewriting open alert_states completely
    writes.length = 0;
    await ingestNodeReport(db, config, baseReport, token);

    const nodeUpdate = writes.find((sql) => sql.startsWith("UPDATE nodes SET"));

    expect(nodeUpdate).toBeDefined();
    expect(nodeUpdate).not.toContain("label =");
    expect(nodeUpdate).not.toContain("is_public =");
    expect(writes.some((sql) => sql.includes("jobs"))).toBeFalsy();
    expect(writes.some((sql) => sql.includes("alert_states"))).toBeFalsy();

    // Changing label, job summary, and alert summary triggers targeted UPDATEs without touching index keys.
    writes.length = 0;
    await ingestNodeReport(
      db,
      config,
      {
        ...baseReport,
        label: "Homelab v2",
        checks: [
          {
            key: "systemd",
            label: "systemd",
            status: "fail",
            summary: "2 failed units",
          },
        ],
        jobs: [
          {
            ...baseReport.jobs![0],
            status: "fail",
            summary: "backup failed",
            detail: "disk full",
          },
        ],
      },
      token,
    );

    const renamedNodeUpdate = writes.find((sql) =>
      sql.startsWith("UPDATE nodes SET"),
    );

    expect(renamedNodeUpdate).toContain("label =");
    expect(renamedNodeUpdate).not.toContain("is_public =");

    const jobUpdate = writes.find((sql) => sql.startsWith("UPDATE jobs"));

    expect(jobUpdate).toBeDefined();
    expect(jobUpdate).not.toContain("node_id =");
    expect(jobUpdate).not.toContain("managed_by_node_id =");

    const alertUpdate = writes.find((sql) =>
      sql.startsWith("UPDATE alert_states SET"),
    );

    expect(alertUpdate).toBeDefined();
    expect(alertUpdate).not.toContain("state =");

    const updatedJob = await inner.first<{
      last_status: string;
      last_summary: string;
    }>(
      "SELECT last_status, last_summary FROM jobs WHERE key = 'homelab:restic'",
    );

    expect(updatedJob).toEqual({
      last_status: "fail",
      last_summary: "backup failed",
    });

    const updatedNode = await inner.first<{ label: string }>(
      "SELECT label FROM nodes WHERE id = 'homelab'",
    );

    expect(updatedNode).toEqual({ label: "Homelab v2" });
  });
});
