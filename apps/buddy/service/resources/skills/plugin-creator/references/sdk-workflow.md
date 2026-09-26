# 独立 SDK 工作流

仅用于用户已提供 Lexora Plugin SDK 的外部开发环境。先确认 SDK 目录和目标插件仓库，不下载其他运行时或猜测私有路径。

源码位于插件仓库 `plugins/<插件名>/`；类型从 SDK 的 `sdk/index.d.ts` 复制为插件内的 `lexora.d.ts`。许可证沿用插件仓库根文件，由 SDK 打包时附加，不在每个源码目录重复放置。

在 SDK 目录运行：

```sh
pnpm check <插件仓库>
pnpm run package <插件仓库>
pnpm run package:source <插件仓库>
```

安装包在 SDK 的 `.output/packages/`。开发预览可使用 `pnpm dev <插件仓库> <插件名>`，采用独立临时配置。打包会更新插件仓库的 `catalog/v1/index.json`，不会上传。运行验证仍需真实 Lexora 窗口；普通浏览器打开文件不能代替插件隔离环境验收。

在 Lexora 的「插件 → 安装插件包」选择输出包并确认权限。只有用户要求发布时才同步远端。

离线开发可从 SDK 的 `authoring.mjs` 导入 `queryWorkbenchCapabilities` 查询该 SDK 快照支持的目标；它不代表用户已安装宿主的版本。应用内优先查询 `lexora_plugin_capabilities`。
