import ui from "@nuxt/ui/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [
    vue(),
    ui({
      icon: { clientBundle: { scan: true } },
      ui: {
        colors: {
          primary: "blue",
          neutral: "zinc",
        },
      },
    }),
  ],
  build: {
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
