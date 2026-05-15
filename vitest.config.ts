import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", ".pi/**", ".direnv/**"],
    environment: "node",
  },
  coverage: {
    provider: "v8",
    include: ["extensions/**/*.ts", "skills/**/*.ts"],
    exclude: [
      "**/*.test.ts",
      "**/dist/**",
      "**/node_modules/**",
      "**/__snapshots__/**",
      "**/__tests__/**",
    ],
    reporter: ["text", "lcov", "html"],
  },
});
