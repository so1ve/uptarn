import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { Unstable_RawConfig as RawConfig } from "wrangler";
import { experimental_readRawConfig } from "wrangler";

export interface DeployEnvOverrides {
  UPTARN_WORKER_NAME?: string;
  UPTARN_D1_DATABASE_NAME?: string;
  UPTARN_D1_DATABASE_ID?: string;
  UPTARN_CUSTOM_DOMAIN?: string;
  UPTARN_PUBLIC_BASE_URL?: string;
}

const DEFAULT_OVERRIDE_FILES = [
  "wrangler.local.jsonc",
  "wrangler.local.json",
  "wrangler.local.toml",
] as const;

const normalizeDomain = (raw: string): string =>
  raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");

export function mergeWranglerConfig(
  base: RawConfig,
  override: RawConfig | null,
  env: DeployEnvOverrides,
): RawConfig {
  const result: RawConfig = {
    ...base,
    ...(override ?? {}),
    ...(base.assets || override?.assets
      ? { assets: { ...base.assets, ...override?.assets } }
      : {}),
    ...(base.vars || override?.vars
      ? { vars: { ...base.vars, ...override?.vars } }
      : {}),
  };

  if (base.d1_databases || override?.d1_databases) {
    const merged = (base.d1_databases ?? []).map((db) => ({ ...db }));
    for (const item of override?.d1_databases ?? []) {
      const idx = merged.findIndex((db) => db.binding === item.binding);
      if (idx === -1) {
        merged.push({ ...item });
      } else {
        merged[idx] = { ...merged[idx], ...item };
      }
    }
    result.d1_databases = merged;
  }

  const workerName = env.UPTARN_WORKER_NAME?.trim();
  if (workerName) {
    result.name = workerName;
  }

  const dbName = env.UPTARN_D1_DATABASE_NAME?.trim();
  const dbId = env.UPTARN_D1_DATABASE_ID?.trim();
  if (dbName || dbId) {
    const d1 = (result.d1_databases ?? []).map((db) => ({ ...db }));
    const idx = d1.findIndex((db) => db.binding === "DB");
    const target = idx === -1 ? { binding: "DB" } : { ...d1[idx] };
    if (dbName) {
      target.database_name = dbName;
    }
    if (dbId) {
      target.database_id = dbId;
    }
    if (idx === -1) {
      d1.push(target);
    } else {
      d1[idx] = target;
    }
    result.d1_databases = d1;
  }

  const domains = (env.UPTARN_CUSTOM_DOMAIN ?? "")
    .split(",")
    .map(normalizeDomain)
    .filter(Boolean);
  if (domains.length > 0) {
    result.routes = domains.map((pattern) => ({
      pattern,
      custom_domain: true,
    }));
  }

  const publicBaseUrl = env.UPTARN_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (publicBaseUrl) {
    result.vars = { ...result.vars, PUBLIC_BASE_URL: publicBaseUrl };
  } else if (domains.length > 0 && !result.vars?.PUBLIC_BASE_URL) {
    result.vars = { ...result.vars, PUBLIC_BASE_URL: `https://${domains[0]}` };
  }

  return result;
}

export function rebaseWranglerPaths(
  config: RawConfig,
  rootDir: string,
  outDir: string,
): RawConfig {
  const rebase = (rel: string): string =>
    path.relative(outDir, path.resolve(rootDir, rel)).replaceAll("\\", "/");

  const next: RawConfig = { ...config };
  delete next.$schema;
  if (next.main) {
    next.main = rebase(next.main);
  }
  if (next.assets?.directory) {
    next.assets = {
      ...next.assets,
      directory: rebase(next.assets.directory),
    };
  }
  if (next.d1_databases) {
    next.d1_databases = next.d1_databases.map((db) =>
      db.migrations_dir
        ? { ...db, migrations_dir: rebase(db.migrations_dir) }
        : { ...db },
    );
  }

  return next;
}

function runCommand(cmd: string, args: string[], cwd: string): void {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

function main(): void {
  const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const rawArgs = process.argv.slice(2);
  const { values } = parseArgs({
    args: rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs,
    options: {
      "override": { type: "string", short: "o" },
      "dry-run": { type: "boolean", default: false },
      "migrate-only": { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      "skip-migrate": { type: "boolean", default: false },
      "config-only": { type: "boolean", default: false },
    },
  });

  const overrideArg =
    values.override?.trim() ||
    process.env.UPTARN_WRANGLER_OVERRIDE?.trim() ||
    null;
  const overridePath = overrideArg
    ? path.resolve(rootDir, overrideArg)
    : (DEFAULT_OVERRIDE_FILES.map((f) => path.join(rootDir, f)).find((p) =>
        fs.existsSync(p),
      ) ?? null);
  if (overrideArg && (!overridePath || !fs.existsSync(overridePath))) {
    throw new Error(`Override config not found: ${overrideArg}`);
  }

  const envOverrides: DeployEnvOverrides = {
    UPTARN_WORKER_NAME: process.env.UPTARN_WORKER_NAME,
    UPTARN_D1_DATABASE_NAME: process.env.UPTARN_D1_DATABASE_NAME,
    UPTARN_D1_DATABASE_ID: process.env.UPTARN_D1_DATABASE_ID,
    UPTARN_CUSTOM_DOMAIN: process.env.UPTARN_CUSTOM_DOMAIN,
    UPTARN_PUBLIC_BASE_URL: process.env.UPTARN_PUBLIC_BASE_URL,
  };
  const hasEnv = Object.values(envOverrides).some((v) => Boolean(v?.trim()));

  let configPath = path.join(rootDir, "wrangler.jsonc");
  if (overridePath || hasEnv) {
    const base = experimental_readRawConfig({ config: configPath }).rawConfig;
    const override = overridePath
      ? experimental_readRawConfig({ config: overridePath }).rawConfig
      : null;
    const outDir = path.join(rootDir, ".wrangler");
    fs.mkdirSync(outDir, { recursive: true });
    configPath = path.join(outDir, "deploy.json");
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(rebaseWranglerPaths(mergeWranglerConfig(base, override, envOverrides), rootDir, outDir), null, 2)}\n`,
    );
    const sources = [
      "wrangler.jsonc",
      ...(overridePath ? [path.relative(rootDir, overridePath)] : []),
      ...(hasEnv ? ["env"] : []),
    ];
    console.log(
      `Generated ${path.relative(rootDir, configPath)} from ${sources.join(" + ")}`,
    );
  }

  if (values["config-only"]) {
    return;
  }

  const relConfig = path.relative(rootDir, configPath);
  if (!values["migrate-only"] && !values["skip-build"]) {
    runCommand("pnpm", ["run", "build"], rootDir);
  }
  if (!values["dry-run"] && !values["skip-migrate"]) {
    runCommand(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "DB",
        "--remote",
        "-c",
        relConfig,
      ],
      rootDir,
    );
  }
  if (!values["migrate-only"]) {
    runCommand(
      "pnpm",
      [
        "exec",
        "wrangler",
        "deploy",
        "-c",
        relConfig,
        ...(values["dry-run"] ? ["--dry-run"] : []),
      ],
      rootDir,
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
