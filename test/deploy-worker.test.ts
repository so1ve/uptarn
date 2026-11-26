import { describe, expect, it } from "vitest";

import {
  mergeWranglerConfig,
  rebaseWranglerPaths,
} from "../scripts/deploy-worker.ts";

describe("deploy-worker config merge", () => {
  it("merges local overrides and env vars without dropping upstream bindings", () => {
    const base = {
      name: "uptarn",
      main: "src/cloudflare.ts",
      keep_vars: true,
      assets: {
        directory: "./web/dist",
        not_found_handling: "single-page-application" as const,
        run_worker_first: ["/api/*", "/ping/*", "/healthz"],
      },
      d1_databases: [
        {
          binding: "DB",
          database_name: "uptarn",
          migrations_dir: "migrations",
        },
      ],
      durable_objects: {
        bindings: [{ name: "LIVE_HUB", class_name: "LiveHub" }],
      },
    };

    const merged = mergeWranglerConfig(
      base,
      {
        d1_databases: [{ binding: "DB", database_id: "local-id" }],
        vars: { CUSTOM_FLAG: "1" },
      },
      {
        UPTARN_WORKER_NAME: "my-uptarn",
        UPTARN_D1_DATABASE_ID: "env-id",
        UPTARN_CUSTOM_DOMAIN: "https://status.example.com/",
      },
    );

    expect(merged.name).toBe("my-uptarn");
    expect(merged.keep_vars).toBeTruthy();
    expect(merged.durable_objects).toEqual(base.durable_objects);
    expect(merged.assets).toEqual(base.assets);
    expect(merged.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "uptarn",
        migrations_dir: "migrations",
        database_id: "env-id",
      },
    ]);
    expect(merged.routes).toEqual([
      { pattern: "status.example.com", custom_domain: true },
    ]);
    expect(merged.vars).toEqual({
      CUSTOM_FLAG: "1",
      PUBLIC_BASE_URL: "https://status.example.com",
    });
  });

  it("rebases relative paths for generated .wrangler/deploy.json", () => {
    const rebased = rebaseWranglerPaths(
      {
        $schema: "node_modules/wrangler/config-schema.json",
        main: "src/cloudflare.ts",
        assets: { directory: "./web/dist" },
        d1_databases: [{ binding: "DB", migrations_dir: "migrations" }],
      },
      "/repo",
      "/repo/.wrangler",
    );

    expect(rebased.$schema).toBeUndefined();
    expect(rebased.main).toBe("../src/cloudflare.ts");
    expect(rebased.assets?.directory).toBe("../web/dist");
    expect(rebased.d1_databases?.[0]?.migrations_dir).toBe("../migrations");
  });
});
