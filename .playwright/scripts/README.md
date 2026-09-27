# Desktop tests

Install workspace dependencies, then run the tests:

```sh
pnpm install
pnpm test
pnpm test:e2e
```

`pnpm test` runs the Vitest suites without launching a GUI. `pnpm test:e2e` builds the current Electron app and runs Playwright Test. Use `pnpm test:e2e --grep 'graceful restart'` to select a scenario.

Linux requires `Xvfb` on `PATH`; the launcher allocates an isolated display for each instance. Electron must be able to run with its Chromium sandbox enabled.

Test data lives under `~/.lexora-test/runs/<runId>/instances/<instance>`. Set `LEXORA_TEST_RUN_ID` to group concurrent callers into one task; each application instance still receives its own directory. Restart the same instance to retain its data.

For concurrent runners, build once with `pnpm --filter @uselexora/lexora-buddy exec electron-vite build`, then run `pnpm exec playwright test --config .playwright/scripts/playwright.config.mjs` in each runner. Do not rebuild the shared application output while tests are running.

Successful tests remove only their own instance data. Failed tests retain it for inspection; set `LEXORA_TEST_KEEP_DATA=1` to retain successful test data too. Each invocation writes a separate Playwright report under `.playwright/runs/<runId>`, with instance diagnostics, screenshots and traces attached.

Electron tests import `test` and `expect` from `fixtures/electron.mjs`. Scenarios belong in `__tests__/*.e2e.mjs`; helper unit tests use Vitest in `__tests__/*.spec.mjs`.
