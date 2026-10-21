import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:3040" },
  webServer: {
    command: "npx next start -p 3040",
    url: "http://127.0.0.1:3040/register",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: "mobile-chrome", use: { ...devices["Pixel 7"] } }],
});
