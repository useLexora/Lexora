---
title: "构建与分发"
description: "选择仓库工具或独立 SDK，构建、调试并分发可安装的插件包。"
---

# 构建与分发

开发源码和安装包是不同产物。保留源码，在目标宿主验证最终 `.lexora-extension` 包，再分发给用户。

## 仓库 CLI

准备好 Lexora 仓库依赖后，在 `apps/buddy` 运行：

```sh
node extensions/tools.mjs check /path/to/plugin
node extensions/tools.mjs build /path/to/plugin .output/extensions/my-plugin
node extensions/tools.mjs pack .output/extensions/my-plugin .output/extensions/my-plugin.lexora-extension
```

check 校验清单、兼容性和包文件；build 生成产物；pack 返回包大小和 SHA-256。输出目录放在源码之外，避免把生成物重新打入插件。

## 独立 SDK

在 `apps/buddy` 中导出开发工具与公共类型快照：

```sh
node extensions/tools.mjs export-sdk /path/to/plugin-sdk/sdk
```

这会导出 `authoring.mjs`、`plugin.mjs` 与 `index.d.ts`，不是安装一个 npm SDK 包，也不自动生成完整的独立工程。已有独立 Lexora Plugin SDK 的作者，在 SDK 目录按其 packageManager 安装依赖后运行：

```sh
pnpm check /path/to/plugin-repository my-plugin
pnpm run package /path/to/plugin-repository my-plugin
pnpm run package:source /path/to/plugin-repository my-plugin
pnpm dev /path/to/plugin-repository my-plugin
```

源码约定在 `<仓库>/plugins/<插件名>/`，安装包位于 SDK 的 `.output/packages/`。打包按插件 ID 增量更新该仓库的 `catalog/v1/index.json`，不会上传。仓库根许可证在打包时附加；保留第三方组件的许可与声明。

类型从 `sdk/index.d.ts` 复制为插件内 `lexora.d.ts`。新身份可用 `authoring.mjs` 的 `createExtensionId` 生成；已有插件持续沿用原 ID。

## 开发与调试

应用可加载开发目录。仓库 CLI 的 dev 命令需先构建 Electron，使用独立临时配置；修改后重新构建并加载。独立 SDK 的开发命令按该工具提供的监听流程运行。

检查当前版本、待应用更新、入口加载状态与诊断。构建失败、权限失败和运行时失败分别处理。加载成功不等于文件保存、工具调用或界面行为已经通过。

## 包内容与依赖

source 包使用宿主固定编译器；compiled 包保留作者已经构建的浏览器模块和资源。运行时需要的 Worker、WASM、样式与静态文件必须随包交付。

当前包预算：单文件 64 MiB、压缩包 128 MiB、展开总计 256 MiB；最多 4096 个文件，非图片最多 512 个，归档条目最多 8192 个。模型权重或其他大型外部数据不应硬塞进插件安装包；使用[推理资源](./inference#准备资源)准备并校验。原生入口 `native/*.mjs` 必须预编译，source 构建也只保留这些脚本，不代装 Node 原生依赖。Skills 的独立目录按原路径保留，MCP 声明和 NPC 定义不携带用户凭据。

## 发布前完成一个完整流程

1. 确认稳定 ID、作者、插件版本、权限与最低宿主版本。
2. 构建并安装最终包，检查所有实际入口和主要功能。
3. 验证取消、关闭、禁用、更新及已有数据恢复；推理逐平台验证真实引擎，数据视图验证绑定与撤权，MCP/NPC 验证真实依赖和用户配置。
4. 保存源码、许可证、安装包和对应大小、SHA-256。
5. 需要进入现有市场时，按 [Lexora Plugins](https://github.com/useLexora/plugins) 的当前发布说明提交。

构建包或更新本地目录不代表已发布。下载地址、版本与校验信息应对应实际可获取的同一安装包。插件社区的账号与提交流程以实际开放渠道为准。
