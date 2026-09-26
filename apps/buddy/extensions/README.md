# Lexora 插件开发

插件可以添加命令、上下文视图与独立配置页面。[Lexora Plugins](https://github.com/useLexora/plugins) 保存平铺的插件源码与市场目录；开发工具及创作 Skill 位于独立的 Lexora Plugin SDK。`sdk/index.d.ts` 提供公共类型，无需发布或安装单独的 npm SDK。

也可以直接在 Lexora 对话中输入 `$plugin-creator` 和需求，例如 `$plugin-creator 打字时窗口出现礼花`。内置技能生成源码并使用 Lexora 编译器打包，随后显示安装确认；源码保留在任务工作区，便于继续修改。

在 `apps/buddy` 中运行（Node.js 24+，已安装 workspace 依赖）：

```sh
node extensions/tools.mjs check /path/to/plugin
node extensions/tools.mjs build /path/to/plugin .output/extensions/my-plugin
node extensions/tools.mjs pack .output/extensions/my-plugin .output/extensions/my-plugin.lexora-extension
```

在「插件 → 安装插件包」中安装生成的包。安装按钮右侧箭头可以加载开发目录；「更多操作 → 安装记录」查看进度、编译错误与取消操作。

`extension.json` 中的 `id` 是稳定的插件身份，创建后在修改、升级和发布时持续复用；可选的 `author` 独立保存作者署名，修改署名不改变 ID。命令和视图 ID 以插件 ID 加 `.` 开头。清单声明版本、`engines.lexora`、API 版本、贡献项、依赖与权限。`categories` 和 `tags` 用于市场分类与搜索。

`icon` 可指定包内 SVG、PNG、JPEG 或 WebP 图标（最多 64 KiB），用于导航、插件卡片与安装弹窗。未提供图标时显示默认线框图标。

`format: "source"` 支持自包含 TS/JS 源码。Lexora 使用固定编译器，不执行 npm 安装、脚本或第三方构建配置。只能导入包内相对路径；含运行时 npm 依赖的插件需要作者预先打包为 `format: "compiled"`。已编译包直接安装，源码包确认权限后编译，失败不会替换已安装版本。

宿主入口导出 `activate(context)`，可选 `deactivate()`。通过 `context.commands.register` 注册清单中声明的命令；订阅资源使用 `context.subscriptions` 清理。`permissions.notifications` 开放系统通知，`permissions.schedules` 开放 Lexora 运行期间的定时命令。定时配置跨重启保存，休眠或退出期间错过的提醒不会补发，卸载会删除定时任务。

视图入口导出 `render(context, container)`，在隔离页面中运行。`location: "context"` 用于上下文标签；`location: "page"` 配合 `contributes.navigation` 可在自动化下方添加入口。通过 `context.commands.execute` 调用自己的宿主命令；使用 `context.environment` 的语言、主题与颜色适配外观，通过 `context.onEnvironmentChange` 响应变化。事件和定时器随 `context.signal` 取消。

`location: "window-overlay"` 提供独立挂载的透明窗口效果，需要 `permissions.windowEffects`。通过 `context.onActivity` 接收不包含输入文字或按键的对话输入活动；视图不会拦截鼠标或焦点，禁用时立即移除。

API 1 不开放 Node、shell 或任意 Desktop API。文件只读，仅能访问用户选中的文件；HTTPS GET 仅访问已确认的来源，不共享浏览器登录态。`context.storage` 保存私有 JSON，`dataVersion` 改变时入口提供 `migrate(previous, from, to)`，失败保留旧数据。上下文视图可用 `setState` 保存标签状态，独立配置页通过宿主命令保存设置。

更新安装后，当前版本继续运行，点击“重启扩展”应用更新。禁用停止插件，重新启用保留配置；卸载保留私有 JSON 与上下文视图位置，但移除代码和定时任务。

需要独立开发窗口时，先构建 Electron，再运行 `node extensions/tools.mjs dev /path/to/plugin`。开发窗口使用单独的临时配置；修改后重新加载构建目录并重启扩展。SDK 快照可以通过 `node extensions/tools.mjs export-sdk /path/to/plugin-sdk/sdk` 导出。

API 2 通过 `contributes.placements` 提供装饰、工作台面板与思考等级控件。API 3 增加可选择的内容区、操作菜单、独立分屏挂载、带插件命名空间的输入命令与可取消交互。创作时用 `lexora_plugin_capabilities` 按需查询当前宿主支持的位置。内容仍在隔离视图运行；清单和调用示例见 [插件协议](../service/resources/skills/plugin-creator/references/protocol.md)。旧版插件继续可用。
