import { defineConfig, devices } from '@playwright/test'

const PORT = process.env.E2E_PORT ?? '18399'

export default defineConfig({
  testDir: './tests',
  // The suite drives one shared stack, and several specs mutate the same
  // workspace, so running files in parallel would make them fight over state.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // One retry in CI, none locally. A test that passes only on retry is
  // reported as flaky rather than green, which keeps the signal honest instead
  // of papering over a race.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // Point at the real Compose stack rather than a dev server: the deployment
  // bugs this project actually hit were invisible to `vite dev`.
  //
  // stack-up.sh detaches and exits once the stack is healthy, which Playwright
  // would treat as a crashed server, so the command is held open afterwards.
  // `sleep infinity` is GNU-only and fails on macOS, so block portably.
  webServer: {
    command: './stack-up.sh && tail -f /dev/null',
    url: `http://localhost:${PORT}/api/v1/health`,
    reuseExistingServer: true,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
