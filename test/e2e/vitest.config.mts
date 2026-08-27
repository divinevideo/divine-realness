import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const migrations = await readD1Migrations("./worker/migrations");

export default defineWorkersConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    poolOptions: {
      workers: {
        main: "./worker/src/index.ts",
        singleWorker: true,
        miniflare: {
          compatibilityDate: "2024-12-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          queueProducers: { ACTION_QUEUE: "moderation-actions-queue" },
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Present so submitToRealityDefender proceeds past its key guard
            // and actually attempts the video download - that outbound fetch
            // is what proves the gate let the event through.
            REALITY_DEFENDER_API_KEY: "test-key-not-a-real-secret",
          },
        },
      },
    },
  },
});
