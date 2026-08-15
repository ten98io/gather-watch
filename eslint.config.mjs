// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/next-env.d.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain-JS tool configs (babel/metro/next) run in Node's CJS scope.
    files: ["**/*.config.js", "**/*.config.cjs"],
    languageOptions: {
      globals: {
        module: "writable",
        require: "writable",
        __dirname: "writable",
        process: "writable",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    rules: {
      // Standard convention: names prefixed with "_" are intentionally unused
      // (e.g. destructure-to-omit), and rest-sibling omission is deliberate.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
