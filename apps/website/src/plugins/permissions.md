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
| 当前任务标题与消息文本 | `tasks: "read"` / `"title"`、独立的 `taskMessages: true` |
| HTTPS GET、下载和外链 | `network: ["https://example.com"]` |
| 窗口样式与装饰、控件替换 | `windowEffects: true`、`controls: ["model.reasoning"]` |
| 系统通知、定时命令 | `notifications: true`、`schedules: true` |
| 修改用户主题、声明解释器候选 | `themeManagement: true`、`shells: true` |

读取文件不授予写回权；工具声明 `access: "write"` 也不自动授予文件或文档权限。资源句柄和引用定位信息都不是任意路径授权。

## 运行环境

通过 `network` 访问已批准的 HTTPS 来源，不能用直接外网 `fetch` 或远程脚本绕过。安装不共享浏览器登录态，模型凭据留在宿主。

剪贴板仅供当前前台可见、聚焦的交互视图使用，读写权限独立；这不是逐次用户手势确认。后台、装饰、插槽和控件不能读取剪贴板。文档编辑也仅在交互视图中开放。

## 三种版本

| 字段 | 表示什么 |
| --- | --- |
| `version` | 这份插件的发布版本 |
| `apiVersion` | 插件协议主版本，当前支持 1–4 |
| `engines.lexora` | 实际支持该插件全部能力的宿主版本范围 |

例如，API 4 内新增接口可以要求 Lexora 0.17.0；只写 API 4 并不足以保证旧宿主可用。[文档编辑](./files#编辑原件与恢复)和引用捕获应按对应版本使用。不要通过降低兼容范围绕过安装检查。

在应用内可查询当前宿主能力；独立 SDK 的能力目录只反映该 SDK 快照。可选能力缺失时提示升级或关闭该功能，不能伪造成功。

## 处理失败

取消文件选择、过期视图、撤销授权和保存冲突是不同结果。按具体接口处理 `null`、`false`、返回状态与异常；不要把所有异常转成空内容。

超时可能表示结果尚未确认。涉及写入时先读取状态或恢复回执，再决定下一步，避免盲目重放。排错时记录插件 ID、版本、方法与错误码，避免记录凭据和材料正文。
