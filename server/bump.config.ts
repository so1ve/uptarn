import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { defineConfig } from "bumpp";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cargoTomlPath = path.join(repoRoot, "Cargo.toml");
const cargoLockPath = path.join(repoRoot, "Cargo.lock");

export default defineConfig({
  commit: "chore: release v%s",
  tag: "v%s",
  execute(operation) {
    const nextVersion = operation.state.newVersion;
    const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
    const updated = cargoToml.replace(
      /(\[workspace\.package\][\s\S]+?^version\s*=\s*")[^"]+(")/m,
      `$1${nextVersion}$2`,
    );
    if (
      updated === cargoToml &&
      !cargoToml.includes(`version = "${nextVersion}"`)
    ) {
      throw new Error(
        "Failed to update [workspace.package].version in Cargo.toml",
      );
    }
    fs.writeFileSync(cargoTomlPath, updated);
    execFileSync("cargo", ["update", "-p", "uptarn-agent", "--offline"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    operation.update({
      updatedFiles: [
        ...operation.state.updatedFiles,
        cargoTomlPath,
        cargoLockPath,
      ],
    });
  },
});
