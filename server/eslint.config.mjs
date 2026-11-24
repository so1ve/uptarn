import { so1ve } from "@so1ve/eslint-config";

export default so1ve({
  vue: true,
  ignores: [
    "**/.wrangler/**",
    "public/**",
    "worker-configuration.d.ts",
    "web/src/auto-imports.d.ts",
    "web/src/components.d.ts",
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
