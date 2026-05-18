import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/infrastructure/db/schema/sqlite/index.ts",
  out: "./drizzle/sqlite",
  dialect: "sqlite",
  strict: true,
});
