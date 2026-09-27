# 参与贡献 / Contributing

## 中文

欢迎提交针对 Lexora 的问题修复和改进。[新建 Issue](https://github.com/useLexora/Lexora/issues/new/choose) 时请选择缺陷报告、功能建议或文档问题；其他话题可以使用空白 Issue，安全漏洞请[私密报告](https://github.com/useLexora/Lexora/security/advisories)。每个 Issue 聚焦一个问题。缺陷报告请写明版本、运行环境、复现步骤和实际与预期结果。提交日志或截图前，请移除密钥和个人信息。

较大的产品变更请先通过 Issue 讨论方向。准备提交 PR 时：

1. Fork 仓库，从最新的 `master` 创建分支。
2. 按 [本地开发说明](README.md#本地开发)安装依赖并运行相关应用。Node.js 和 pnpm 版本以根目录的 `.node-version`、`package.json` 为准。
3. 提交前运行 `pnpm lint`、`pnpm type-check`，并运行与改动有关的测试。修改 Buddy 时可先运行 `pnpm --filter @uselexora/lexora-buddy test:unit`。
4. 向 `useLexora/Lexora:master` 提交 PR，说明变更、验证方式；界面改动请附截图或短录屏。

PR 会运行按改动范围选择的检查。首次从 fork 贡献时，GitHub 可能要求维护者批准工作流；等待批准即可，无需重新提交 PR。合并前，PR 的 `CI Gate` 必须通过。

## English

Bug fixes and improvements are welcome. When [opening an issue](https://github.com/useLexora/Lexora/issues/new/choose), choose the bug, feature, or documentation form; use a blank issue for other topics and [report security vulnerabilities privately](https://github.com/useLexora/Lexora/security/advisories). Keep each issue focused on one problem. Bug reports should include the version, environment, reproduction steps, and actual and expected behavior. Remove secrets and personal information from logs or screenshots.

For larger product changes, discuss the direction in an issue first. When preparing a PR:

1. Fork the repository and create a branch from the latest `master`.
2. Install dependencies and run the relevant app using the [local development guide](README.en.md#local-development). The root `.node-version` and `package.json` define the Node.js and pnpm versions.
3. Run `pnpm lint`, `pnpm type-check`, and tests relevant to your changes before submitting. For Buddy changes, you can start with `pnpm --filter @uselexora/lexora-buddy test:unit`.
4. Open a PR against `useLexora/Lexora:master`. Describe the change and how you verified it; include a screenshot or short recording for UI changes.

PR checks are selected by the changed files. GitHub may require maintainer approval before running workflows for a first contribution from a fork; you do not need to reopen the PR. The `CI Gate` must pass before merging.
