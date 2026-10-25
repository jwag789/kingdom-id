import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/drizzle/**", "**/playwright-report/**", "conformance/.suite/**", "conformance/results/**", "**/.next/**", "**/next-env.d.ts", "deploy/aws/.terraform/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // Browser script served as-is to the sign-in pages.
    files: ["apps/idp/public/**/*.js"],
    languageOptions: { globals: { window: "readonly", document: "readonly", navigator: "readonly", fetch: "readonly", atob: "readonly", btoa: "readonly", PublicKeyCredential: "readonly", AbortController: "readonly" } },
  },
  {
    // k6 scripts run in k6's JavaScript runtime, which provides these globals.
    files: ["scaling/k6/**/*.js"],
    languageOptions: { globals: { open: "readonly", __ENV: "readonly", __VU: "readonly" } },
  },
  {
    files: ["e2e/*.mjs"],
    languageOptions: { globals: { process: "readonly" } },
  },
  {
    files: ["**/scripts/**", "**/*.config.*", "e2e/**", "scaling/**"],
    rules: { "no-console": "off" },
  },
);
