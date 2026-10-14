import { defineConfig } from "@playwright/test";

const PORT = 8790;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${PORT}`, acceptDownloads: true },
  webServer: {
    // Postgres container + server (see the script)
    command: `PORT=${PORT} scripts/e2e-server.sh`,
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
  },
});
