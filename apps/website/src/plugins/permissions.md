---
title: "权限与兼容性"
description: "按能力声明最小权限，区分 API 版本、宿主版本和插件版本。"
---

# 权限与兼容性

权限在 `extension.json` 的 `permissions` 中声明，由用户在安装时审核。只申请当前功能确实需要的权限。

## 选择权限

| 功能 | 声明 |
| --- | --- |
| 使用宿主传入的文件 | `selectedResource: "read"` |
| 让用户选择其他文件或目录 | `localResources: true` |
| 导出到用户选择的位置 | `resourceExport: true` |
| 编辑原件与维护恢复草稿 | `fileEditing: true` |
| 引用到对话及工具解析引用 | `references: true` |
| 读取或写入文本、HTML 剪贴板 | `clipboardRead: true` / `clipboardWrite: true` |
| 注册 Agent 工具或任务动作 | `agent: true` |
| 在调用期间请求模型 | `models: true` |
| 提供原生推理后端 | `inference: true` |
| 推理 GPU 与服务请求 | `inferenceGpu: true`、独立的 `inferenceNetwork: ["https://api.example.com"]` |
| 读取绑定范围的统计或上下文用量 | `data: ["task.metrics", "context.usage"]`，按需选择来源 |
| 当前任务标题与消息文本 | `tasks: "read"` / `"title"`、独立的 `taskMessages: true` |
| HTTPS GET、下载和外链 | `network: ["https://example.com"]` |
| 窗口样式与装饰、控件替换 | `windowEffects: true`、`controls: ["model.reasoning"]` |
| 系统通知、定时命令 | `notifications: true`、`schedules: true` |
| 修改用户主题、声明解释器候选 | `themeManagement: true`、`shells: true` |

读取文件不授予写回权；工具声明 `access: "write"` 也不自动授予文件或文档权限。资源句柄和引用定位信息都不是任意路径授权。

Skills、MCP 和 NPC 的声明不要求 `agent` 或额外插件权限，但不代表可自动执行工具、连接远端或绑定伙伴，见[能力包](./capabilities)。数据来源权限不授予任务正文或任意任务访问，见[视图数据](./views#只读数据与绑定范围)。

## 运行环境

通过 `network` 访问已批准的 HTTPS 来源，不能用直接外网 `fetch` 或远程脚本绕过。安装不共享浏览器登录态，模型凭据留在宿主。

原生推理使用[独立权限与平台边界](./inference#权限与平台边界)：普通下载走 `network`，推理服务走 `inferenceNetwork`。Windows x64 与实验性 macOS ARM64 的受监督原生进程以当前账户运行，不提供操作系统文件和网络隔离；浏览器后台、视图及 Worker 的限制不变。

剪贴板仅供当前前台可见、聚焦的交互视图使用，读写权限独立；这不是逐次用户手势确认。后台、装饰、插槽和控件不能读取剪贴板。文档编辑也仅在交互视图中开放。

## 三种版本

| 字段 | 表示什么 |
| --- | --- |
| `version` | 这份插件的发布版本 |
| `apiVersion` | 插件协议主版本，当前支持 1–5 |
| `engines.lexora` | 实际支持该插件全部能力的宿主版本范围 |

例如，API 4 内新增接口可以要求 Lexora 0.17.0；只写 API 4 并不足以保证旧宿主可用。[文档编辑](./files#编辑原件与恢复)和引用捕获应按对应版本使用。不要通过降低兼容范围绕过安装检查。

推理、MCP/NPC 和视图数据的增量接口也须核对目标宿主。新增数据来源、GPU 或受监督推理平台等权限范围需要重新审阅，不沿用旧批准推断新增授权。

在应用内可查询当前宿主能力；独立 SDK 的能力目录只反映该 SDK 快照。可选能力缺失时提示升级或关闭该功能，不能伪造成功。

## 处理失败

取消文件选择、过期视图、撤销授权和保存冲突是不同结果。按具体接口处理 `null`、`false`、返回状态与异常；不要把所有异常转成空内容。

超时可能表示结果尚未确认。涉及写入时先读取状态或恢复回执，再决定下一步，避免盲目重放。排错时记录插件 ID、版本、方法与错误码，避免记录凭据和材料正文。

## 执行范围

`executionScope` 默认为 `desktop`，插件随桌面运行。API 5 插件可显式声明 `service`，在桌面关闭后继续服务正在执行的任务；这项变化会出现在安装审核中，全部运行依赖也必须声明 service。

service 包必须提供 `entry`，不能申请 `schedules`，API 5 拒绝未知权限。激活阶段只注册能力、读取配置并初始化私有数据；模型、任务与网络操作需要本次有效调用及其取消信号。无任务或界面使用时后端停止。窗口、选择器和选区操作仍需要桌面，离线时返回 `EXTENSION_DESKTOP_REQUIRED`。此声明不授予 Node 或额外系统权限。
