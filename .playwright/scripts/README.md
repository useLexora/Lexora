# Desktop 测试

安装工作区依赖后执行：

```sh
pnpm install
pnpm test
pnpm test:e2e
```

`pnpm test` 执行无 GUI 的 Vitest 测试。`pnpm test:e2e` 构建当前 Electron 应用并执行 Playwright Test；可追加测试文件名或 `--grep` 筛选场景。Linux 需要 `Xvfb`，Electron 必须能启用 Chromium sandbox。

Electron 测试位于 `__tests__/*.e2e.mjs`，复用 `fixtures/electron.mjs` 的 `test`、`expect`；辅助逻辑测试使用 `__tests__/*.spec.mjs`。
