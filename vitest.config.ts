import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
          exclude: ["**/*.live.test.ts"],
          testTimeout: 120_000,
        },
      },
      {
        test: {
          name: "live",
          include: ["packages/*/test/**/*.live.test.ts", "apps/*/test/**/*.live.test.ts"],
          testTimeout: 1_800_000,
        },
      },
    ],
  },
});
