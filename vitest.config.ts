import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/portable.test.ts",
      "test/runtime-settings.test.ts",
      "test/deploy-worker.test.ts",
      "test/write-optimization.test.ts",
      "test/cli.test.ts",
    ],
  },
});
