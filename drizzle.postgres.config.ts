import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/infrastructure/db/schema/postgres/index.ts",
  out: "./drizzle/postgres",
  dialect: "postgresql",
  strict: true,
});
