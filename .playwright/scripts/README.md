# Desktop 测试

安装工作区依赖后执行：

```sh
pnpm install
pnpm test
pnpm test:e2e
```

`pnpm test` 执行无 GUI 的 Vitest 测试。`pnpm test:e2e` 构建当前 Electron 应用并执行 Playwright Test；可追加测试文件名或 `--grep` 筛选场景。Linux 需要 `Xvfb`，Electron 必须能启用 Chromium sandbox。

运行产物位于 `.playwright/runs/YYYY-MM-DD/<task>/HH-mm-ss/`，同秒重跑自动编号。每批包含 `run.json`、Playwright 报告、附件与日志。可指定任务名：

```sh
LEXORA_TEST_TASK=buddy-settings pnpm test:e2e settings.e2e.mjs
```

实例数据位于 `~/.lexora-test/runs/<runId>/instances/<instance>`。设置 `LEXORA_TEST_RUN_ID` 可让并发调用归入同一任务，各实例仍使用独立数据目录。成功只清理本实例数据；失败保留，`LEXORA_TEST_KEEP_DATA=1` 可保留成功实例。

并发运行时先构建一次，再分别执行 `pnpm exec playwright test --config .playwright/scripts/playwright.config.mjs`，避免重复构建共享产物。

Electron 测试位于 `__tests__/*.e2e.mjs`，复用 `fixtures/electron.mjs` 的 `test`、`expect`；辅助逻辑测试使用 `__tests__/*.spec.mjs`。
