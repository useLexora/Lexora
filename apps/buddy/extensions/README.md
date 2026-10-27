# Lexora 插件开发

插件是可安装、启用、更新和卸载的功能包，可以提供界面、文件处理、命令、Agent 工具、Skills 或主题。协议中的 `Extension` 指同一套工作台插件；它与 Agent 内部扩展的加载方式和权限边界不同。

- [开发文档](https://uselexora.app/plugins/)：从第一个插件到文件编辑、Agent 能力和分发。
- [本地能力索引](../service/resources/skills/plugin-creator/references/capabilities.md)：按开发目标找到接口专题。
- [清单与兼容性](../service/resources/skills/plugin-creator/references/protocol.md)、[公共类型](sdk/index.d.ts)：核对字段与调用签名。
- [Lexora Plugins](https://github.com/useLexora/plugins)：插件源码与市场目录。

也可以在 Lexora 对话中输入 `$plugin-creator` 和需求，由伙伴生成源码与安装包，确认安装后继续迭代。

## 仓库开发工具

使用当前仓库 `package.json` 要求的 Node.js 与 pnpm 版本，安装 workspace 依赖后，在 `apps/buddy` 中运行：

```sh
node extensions/tools.mjs check /path/to/plugin
node extensions/tools.mjs build /path/to/plugin .output/extensions/my-plugin
node extensions/tools.mjs pack .output/extensions/my-plugin .output/extensions/my-plugin.lexora-extension
```

在「插件 → 安装插件包」安装输出包，或从相邻菜单加载开发目录。`check` 校验清单与包；构建和加载通过后，仍需在真实 Lexora 中验证交互、关闭和重新启用。

先构建 Electron，再用 `node extensions/tools.mjs dev /path/to/plugin` 打开独立开发窗口。它使用临时配置，修改后重新构建并加载；不会替代正式安装包验证。

## 独立 SDK

`node extensions/tools.mjs export-sdk /path/to/plugin-sdk/sdk` 导出开发工具和公共类型快照。类型可复制为插件内的 `lexora.d.ts`，仅通过 `import type` 引用，无需安装 npm SDK 包。已取得独立 SDK 的作者使用 [SDK 工作流](../service/resources/skills/plugin-creator/references/sdk-workflow.md)。

自包含 TS/JS 使用 `source` 包；Vue、React 和其他运行时依赖由作者预先构建为 `compiled` 包。身份、权限、生命周期与保存行为见专题说明，开发和升级时保持插件 ID 稳定。
