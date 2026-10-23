import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  // Base JS rules
  js.configs.recommended,

  // TypeScript rules (all packages)
  ...tseslint.configs.recommended,

  // React hooks rules (React apps only)
  {
    files: [
      "apps/web/**/*.{ts,tsx}",
      "apps/eval-dashboard/**/*.{ts,tsx}",
      "apps/mobile/**/*.{ts,tsx}",
    ],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // Disable rules that conflict with Prettier (must be last)
  prettierConfig,

  // Global ignores
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "packages/database/generated/**",
      "**/*.config.js", // CJS config files (tailwind, postcss, etc.)
    ],
  }
);
