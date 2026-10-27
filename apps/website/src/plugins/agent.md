---
title: "Agent 能力"
description: "声明可调用工具、任务动作、模型请求与配套 Skills。"
---

# Agent 能力

插件可以提供由主模型选择的工具，也可以在任务事件或用户菜单操作时执行独立动作。两者都使用宿主创建的调用上下文。

## 注册工具

声明 `agent: true`、后台入口和 `contributes.agent.tools`。每个工具具有稳定 ID、标题、说明、参数与读写类别。下面是清单片段：

```json
{
  "permissions": { "agent": true },
  "contributes": {
    "agent": {
      "tools": [{
        "id": "example.counter.length",
        "title": "计算字符数",
        "description": "返回提供文本的 Unicode 码点数量。",
        "access": "read",
        "parameters": {
          "type": "object",
          "properties": { "text": { "type": "string" } },
          "required": ["text"],
          "additionalProperties": false
        }
      }]
    }
  }
}
```

在 `activate` 中注册对应处理器：

```ts
context.subscriptions.add(
  context.agent.registerTool(`${context.extension.id}.length`, (input) => {
    return { count: Array.from(String(input.text)).length }
  }),
)
```

参数支持有界嵌套的 object/array，以及 string/number/boolean；对象是封闭结构，不支持任意 JSON Schema 或 `$ref`。改变文档或业务数据的工具应声明 `access: "write"`，并另行取得实际资源权限。

## 使用本次调用

工具回调的第二个参数提供 `scope`、`task`、`models`、`references`、`artifacts`、`results` 和 `signal`，按各自权限开放。不要捕获某次调用的上下文供未来任务使用。

`models.generateText` 请求已配置模型，凭据留在宿主。未指定模型时继承本次调用的模型选择；请求没有隐式对话历史。读取当前任务文本需独立声明 `taskMessages`，读取引用见[引用与来源定位](./references)。

写工具可把自己的私有文件通过 `artifacts.publish` 发布为任务产物。`results.addImage` 提供原生图片结果，不应把 base64 塞入 JSON。后台动作没有这两个结果通道。

## 任务动作

`contributes.agent.actions` 声明动作，由 `context.agent.registerAction` 注册。精确触发名包括 `task:created`、`task:run:before`、`task:reply:started`、`task:input:committed`、`task:turn:completed` 和 `user`。

`user` 对应任务菜单；其余触发由宿主事实驱动，不能通过普通事件订阅伪造。默认后台执行；只有仅含执行前触发的动作可声明 `execution: "blocking"`。前置动作失败可能阻止本次主运行启动，使用前应确认这是期望行为。

动作返回 `{status:'completed'|'skipped',message?}`，调用记录与用量归自身。主对话完成不自动取消独立动作；插件停用、配置变化或目标失效会撤销相关调用。所有触发与载荷见 [SDK 类型](./api)。

## 配套 Skills

API 4 的 `contributes.skills: [{id,path}]` 将包内标准 Skill 目录作为插件贡献提供。目录包含 `SKILL.md`，可附带 references、scripts 和 assets；纯 Skills 包可以没有后台入口。

Skill 描述可复用工作方法；工具说明描述具体可调用能力。Skill 本身不会自动注册工具、启动 MCP 服务或授予文件和命令权限。

## 验证

分别验证模型实际调用工具、参数错误、读写策略、取消和插件停用。动作另外检查触发来源、旧结果失效和用户手动修改保护，不能只验证处理器完成注册。
