import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "*.tsbuildinfo"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Operational scripts log to the console by design
    files: ["scripts/**/*.ts", "migrate-ownership.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
