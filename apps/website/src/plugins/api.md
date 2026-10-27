---
title: "API 参考"
description: "查阅清单、后台上下文、视图、Agent 调用与事件的公共类型。"
---

# API 参考

按执行上下文选择接口。下面的声明直接取自当前公共 SDK 类型；使用者仍须匹配目标宿主版本与所需权限。

## 按对象查询

| 对象 | 用途 | 对应指南 |
| --- | --- | --- |
| `ExtensionContext` | 后台命令、注册、共享数据、通知、调度 | [核心概念](./concepts) |
| `ViewContext` | 界面、资源、剪贴板、引用、状态与关闭 | [视图](./views) |
| `ResourceApi` / `LocalResourceApi` | 私有与已授权文件的读取、生成、导出 | [文件](./files) |
| `DocumentApi` / `EditableDocument` | 内容版本、原件保存和恢复 | [文档](./files#编辑原件与恢复) |
| `AgentToolContext` / `AgentActionContext` | 原任务中的工具或独立动作 | [Agent](./agent) |
| `ReferenceInput` / `ReferenceReveal` | 材料快照和来源定位 | [引用](./references) |
| `WorkerApi` | 包内 Worker 生命周期 | [计算](./workers) |
| `EventSubscriber` / `TaskActionEvents` | 作用域事件与动作来源 | [状态与事件](./settings) |

## 清单字段

`extension.json` 必须提供 `schemaVersion: 1`、稳定 `id`、`name`、`version`、`apiVersion` 和 `engines.lexora`。`format` 区分 source/compiled，`entry` 在需要后台代码时提供。`permissions` 和 `contributes` 按实际能力声明；完整结构示例见[第一个插件](./quick-start#声明插件)。

可选 `author` 是独立署名，`icon` 指向包内图标。`dataVersion` 与视图 `stateVersion` 分别管理数据和实例状态迁移。不要根据其他产品的 manifest 字段推测 Lexora 行为。

## 完整类型声明

复制声明为插件内 `lexora.d.ts`，仅通过 `import type` 使用。独立 SDK 导出同一份类型；声明存在不表示目标安装版已经具备所有增量能力。

::: details 展开公共 SDK 类型
<<< @/../../buddy/service/resources/skills/plugin-creator/references/api.d.ts
:::

## 错误与兼容

异步 API 通过 Promise 返回结果；取消可能是返回值，也可能拒绝请求，按各接口契约处理。保存冲突、授权撤销和视图失效不能被当成成功。模型截断会报 `EXTENSION_MODEL_TRUNCATED`，不会返回被截断的完整答案。

升级插件前检查[权限与兼容性](./permissions)，并在目标宿主验证关键流程。
