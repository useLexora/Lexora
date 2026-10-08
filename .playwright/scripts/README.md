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

## 文件 / Markdown 选区引用

场景文件：`__tests__/selectionReferences.e2e.mjs`。使用上述隔离测试实例，验证真实文字选区、组件右键菜单、未分屏的“引用到对话”、原正文与焦点保留、来源编辑器撤销，以及真实双分屏下向指定另一草稿添加引用。

构建一次后可连续验证：

```sh
pnpm --filter @uselexora/lexora-buddy exec electron-vite build
pnpm exec playwright test --config .playwright/scripts/playwright.config.mjs selectionReferences.e2e.mjs --repeat-each=2
```

创建测试空间仅是准备步骤：等待输入框就绪后分派 DOM 点击事件打开弹窗，避免启动期焦点或悬停状态造成不稳定；这一准备步骤不代表键盘创建空间已验收。实际引用操作仍使用真实键盘选区、鼠标右键和组件菜单点击。

主菜单和子菜单的长文字采用 DOM 文本夹具验证宽度上限与省略，不修改真实任务名称或身份。复制命令在测试实例主进程中拦截，仅验证可信接口分派，不读取或改变用户的系统剪贴板；它不代表剪贴板实际内容已经验收。引用菜单使用真实 NDropdown（下拉菜单组件）点击，不再以 Electron `Menu.popup`（弹出菜单接口）的点击测试桩代替。

开发预览仍使用隔离的 `development` 配置，安装版不在测试操作范围内。该场景不调用真实模型，也不替代人工桌面验收；完整范围见 `docs/specs/feature-013-workbench-selection-reference.md`。
