# Desktop 测试

安装工作区依赖后执行：

```sh
pnpm install
pnpm test
pnpm test:e2e
```

`pnpm test` 执行无 GUI 的 Vitest 测试。`pnpm test:e2e` 构建当前 Electron 应用并执行 Playwright Test；可追加测试文件名或 `--grep` 筛选场景。Linux 需要 `Xvfb`，Electron 必须能启用 Chromium sandbox。

Electron 测试位于 `__tests__/*.e2e.mjs`，复用 `fixtures/electron.mjs` 的 `test`、`expect`；辅助逻辑测试使用 `__tests__/*.spec.mjs`。

Android 已安装调试 APK 和测试 APK、并通过 `adb` 连接后，可运行双端审批、草稿、附件、历史、进程恢复与任务控制联测：

```sh
LEXORA_TEST_ANDROID_SERIAL=emulator-5554 pnpm test:e2e mobile-desktop.e2e.mjs mobile-approvals.e2e.mjs mobile-task-controls.e2e.mjs mobile-history.e2e.mjs mobile-recovery.e2e.mjs mobile-content.e2e.mjs mobile-interruption.e2e.mjs
# 普通 Node Core 与 Electron Host 联测需先构建配套服务
pnpm --filter @uselexora/lexora-buddy build:desktop
LEXORA_TEST_MOBILE_SERVICE_MODE=daemon LEXORA_TEST_ANDROID_SERIAL=emulator-5554 pnpm exec playwright test --config .playwright/scripts/playwright.config.mjs mobile-desktop.e2e.mjs mobile-approvals.e2e.mjs mobile-task-controls.e2e.mjs mobile-history.e2e.mjs mobile-recovery.e2e.mjs mobile-content.e2e.mjs mobile-interruption.e2e.mjs
```
