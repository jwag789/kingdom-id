import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/drizzle/**", "**/playwright-report/**", "conformance/.suite/**", "conformance/results/**"] },
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
    files: ["e2e/*.mjs"],
    languageOptions: { globals: { process: "readonly" } },
  },
  {
    files: ["**/scripts/**", "**/*.config.*", "e2e/**"],
    rules: { "no-console": "off" },
  },
);
