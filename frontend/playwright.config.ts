import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:8002",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1363, height: 936 },
      },
    },
  ],
  webServer: {
    command: "uv run --project .. python ../scripts/e2e_server.py",
    url: "http://127.0.0.1:8002/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
