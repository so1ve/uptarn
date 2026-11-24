import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { unixNow } from "../shared/index.ts";
import type {
  SqlDatabase,
  SqlParam,
  SqlRunResult,
  SqlStatement,
} from "./index.ts";

export interface NodeDatabase extends SqlDatabase {
  close: () => void;
}

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../migrations");

export function openNodeSqlite(dbPath: string): NodeDatabase {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }

  return {
    async first<T>(
      sql: string,
      params: readonly SqlParam[] = [],
    ): Promise<T | null> {
      const row = db.prepare(sql).get(...params);

      return (row as T | undefined) ?? null;
    },

    async all<T>(sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[];
    },

    async allBatch(statements: readonly SqlStatement[]): Promise<unknown[][]> {
      return statements.map((statement) =>
        db.prepare(statement.sql).all(...(statement.params ?? [])),
      );
    },

    async run(
      sql: string,
      params: readonly SqlParam[] = [],
    ): Promise<SqlRunResult> {
      const result = db.prepare(sql).run(...params);

      return { changes: Number(result.changes) };
    },

    async batch(
      statements: readonly SqlStatement[],
    ): Promise<readonly SqlRunResult[]> {
      if (statements.length === 0) {
        return [];
      }

      db.exec("BEGIN IMMEDIATE;");
      try {
        const results: SqlRunResult[] = [];
        for (const statement of statements) {
          const result = db
            .prepare(statement.sql)
            .run(...(statement.params ?? []));
          results.push({ changes: Number(result.changes) });
        }
        db.exec("COMMIT;");

        return results;
      } catch (error) {
        db.exec("ROLLBACK;");

        throw error;
      }
    },

    close(): void {
      db.close();
    },
  };
}

const splitSqlStatements = (sql: string): string[] =>
  sql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

export async function applyMigrations(db: SqlDatabase): Promise<string[]> {
  await db.run(
    `CREATE TABLE IF NOT EXISTS _uptarn_migrations (
       name TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );

  const existing = await db.all<{ name: string }>(
    "SELECT name FROM _uptarn_migrations",
  );
  const applied = new Set(existing.map((row) => row.name));
  const newlyApplied: string[] = [];

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const name of files) {
    if (applied.has(name)) {
      continue;
    }
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
    await db.batch([
      ...splitSqlStatements(content).map((sql) => ({ sql })),
      {
        sql: "INSERT INTO _uptarn_migrations (name, applied_at) VALUES (?1, ?2)",
        params: [name, unixNow()],
      },
    ]);
    newlyApplied.push(name);
  }

  return newlyApplied;
}
