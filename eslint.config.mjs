import { so1ve } from "@so1ve/eslint-config";

export default so1ve({
  vue: true,
  ignores: [
    "**/.devenv/**",
    "**/.direnv/**",
    "**/.wrangler/**",
    "target/**",
    "web/dist/**",
    "worker-configuration.d.ts",
    "web/auto-imports.d.ts",
    "web/components.d.ts",
  ],
  typescript: {
    overrides: {
      "ts/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: true } },
      ],
    },
  },
  rules: {
    "no-console": "off",
  },
});
