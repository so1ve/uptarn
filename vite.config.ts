import path from "node:path";

import ui from "@nuxt/ui/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "web"),
  plugins: [
    vue(),
    ui({
      autoImport: {
        dts: path.resolve(import.meta.dirname, "web/src/auto-imports.d.ts"),
      },
      components: {
        dts: path.resolve(import.meta.dirname, "web/src/components.d.ts"),
      },
      icon: {
        clientBundle: {
          scan: true,
        },
      },
      ui: {
        colors: {
          primary: "blue",
          neutral: "zinc",
        },
      },
    }),
  ],
  build: {
    outDir: path.resolve(import.meta.dirname, "public"),
    emptyOutDir: true,
    target: "esnext",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "echarts",
              test: /node_modules\/(echarts|zrender)/,
            },
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/healthz": "http://127.0.0.1:8787",
    },
  },
});
