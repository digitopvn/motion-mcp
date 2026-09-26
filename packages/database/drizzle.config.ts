import { defineConfig } from "drizzle-kit";

/** `pnpm --filter @motion-mcp/database exec drizzle-kit generate` writes SQL migrations to ./drizzle. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
