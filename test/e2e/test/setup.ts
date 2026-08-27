import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";

const testEnv = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
