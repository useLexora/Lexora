# Agent 工具与声明式设置

这些是 API 3 的增量能力。先查询当前宿主的 `runtime` 能力目录，确认 `agent.tools`、`agent.models`、`agent.task` 或 `settings` 可用，再声明对应的最低 `engines.lexora`。

## 设置

`contributes.settings` 包含三个可选数组：

- `modules: [{id,title,order?}]`：设置侧栏中的独立模块。
- `groups: [{id,module,title,order?}]`：模块中的分组。module 引用自己的模块或能力目录列出的内置模块。
- `items: [{id,key,group,title,description?,type,default,order?}]`：分组中的单项。group 引用自己的分组或能力目录开放的内置分组。

所有 id 以插件 ID 加 `.` 开头且全包唯一；key 在本插件内唯一，使用以小写字母开头的字母数字名称。order 范围 -1000–1000，默认 0。插件不能覆写宿主设置或插入其他插件的设置。

type 支持 boolean、string（最长 8192 字符）、number（可声明 min/max）、select（声明 `options:[{label,value}]`）、model。默认值必须符合类型；model 值为 `{providerId,modelId}` 或 null，空值表示采用调用工具的本轮模型。指定模型不可用时会失败，不会静默改用其他模型。

宿主自动保存设置，插件用 `context.configuration.get()` 读取，使用 `configuration.onChange` 注册可等待的热应用处理器；`context.events.on('configuration:changed', listener)` 仅观察已经保存的配置；订阅与失败回退见 [作用域事件](events.md)。修改设置取消当前插件调用，Agent 贡献变化从下一轮生效；关闭功能后旧工具也被拒绝。配置与 storage 私有业务数据独立，不维护第二份持久设置真源。已发布 key 保持类型和含义稳定，新增 key 使用 default。升级后不符合新选项或范围的旧值会被保留并在设置中标记，用户可以逐项修改或恢复默认值；修复前 Agent 贡献不可用。禁用和普通卸载保留配置；用户选择“卸载并清理”时删除配置、私有数据和视图状态。

## Agent 入口

声明 `permissions.agent: true`、宿主 entry，并添加 `contributes.agent`：

- enabledWhen：可选，引用本插件 boolean 设置，值为 true 时贡献生效。
- instructions：可选使用指引，最长 8000 字符；`{{<plugin-id>.tool}}` 替换为实际工具名，不硬编码运行时名称。
- tools：`[{id,title,description,parameters}]`，最多 16 个，必须在 activate 中全部注册。

parameters 为封闭对象，例如：`{type:"object",properties:{summary:{type:"string",description:"任务摘要"}},required:["summary"],additionalProperties:false}`。支持最多 16 个 string/number/boolean 字段，不支持嵌套 schema 或外部引用。

```ts
context.agent.registerTool(`${context.extension.id}.tool`, async (input, invocation) => {
  const configuration = await context.configuration.get()
  const task = await invocation.task.get()
  if (task.titleSource === 'manual')
    return { applied: false }
  const result = await invocation.models.generateText({
    prompt: String(input.summary),
    model: typeof configuration.model === 'object' ? configuration.model : null,
    maxTokens: 256,
  })
  return invocation.task.rename({ title: result.text.trim(), expectedRevision: task.titleRevision })
})
```

回调返回 JSON。invocation 仅在本次回调内有效；回调结束、任务取消、插件禁用、更新或崩溃后不能继续使用。遵守 `invocation.signal`，不保留句柄给其他任务或后台定时器。工具失败不应阻断原任务。

## 模型与任务权限

`permissions.models: true` 开放 `invocation.models.generateText({prompt,system?,model?,maxTokens?})`，返回 `{text,model}`。未指定模型时使用本轮模型，显式指定不可用模型则失败。请求仅有文本，没有工具或隐式对话历史；不允许自定义凭据、URL 或 Provider 参数。凭据留在宿主，用量计入当前运行。最多 4 次模型请求，每次最多 4096 输出 token，整个工具调用限时 120 秒。

`permissions.tasks: "read"` 开放 task.get，返回当前任务的 id/title/titleSource/titleRevision；`"title"` 额外开放 rename。标题为单行 1–80 字符，比较版本后返回 `{applied}`。手动标题、历史来源不明的标题、已删除任务和过期版本不被覆盖；改名不更新任务活动时间。API 不接受调用者指定的任务 ID，不读取其他任务或聊天历史，不提供任意字段写入。
