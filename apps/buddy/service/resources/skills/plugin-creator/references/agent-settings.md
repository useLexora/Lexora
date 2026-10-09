# Agent 工具、任务动作与设置

这些是 API 3 的增量能力。先查询当前宿主的 `runtime` 能力目录，确认所需的 `agent.tools`、`agent.actions`、`agent.models`、`agent.task`、`agent.taskMessages` 或 `settings` 可用，再声明对应的最低 `engines.lexora`。相同 API 版本的旧宿主不一定提供全部增量能力。

## 设置

`contributes.settings` 包含三个可选数组：

- `modules: [{id,title,order?}]`：设置侧栏中的独立模块。
- `groups: [{id,module,title,order?}]`：模块中的分组。module 引用自己的模块或能力目录列出的内置模块。
- `items: [{id,key,group,title,description?,type,default,order?,enabledWhen?}]`：分组中的单项。group 引用自己的分组或能力目录开放的内置分组。

所有 id 以插件 ID 加 `.` 开头且全包唯一；key 在本插件内唯一，使用以小写字母开头的字母数字名称。order 范围 -1000–1000，默认 0。插件不能覆写宿主设置或插入其他插件的设置。

type 支持 boolean、string（最长 8192 字符）、number（可声明 min/max）、select（声明 `options:[{label,value}]`）、model。默认值必须符合类型；model 值为 `{providerId,modelId}` 或 null。模型选择规则见下文，指定模型不可用时会失败，不会静默改用其他模型。

宿主自动保存设置，插件用 `context.configuration.get()` 读取，使用 `configuration.onChange` 注册可等待的热应用处理器；`context.events.on('configuration:changed', listener)` 仅观察已经保存的配置；订阅与失败回退见 [作用域事件](events.md)。修改设置取消当前插件调用，Agent 贡献变化从下一轮生效；关闭功能后旧工具也被拒绝。配置与 storage 私有业务数据独立，不维护第二份持久设置真源。已发布 key 保持类型和含义稳定，新增 key 使用 default。升级后不符合新选项或范围的旧值会被保留并在设置中标记，用户可以逐项修改或恢复默认值；修复前 Agent 贡献不可用。禁用和普通卸载保留配置；用户选择“卸载并清理”时删除配置、私有数据和视图状态。

设置项的 `enabledWhen: {condition,params?}` 引用插件注册的[条件函数](conditions.md)。关闭条件仅禁用输入并保留原值；控制开关自身保持可编辑。

## Agent 入口

声明 `permissions.agent: true`、宿主 entry，并添加 `contributes.agent`：

- enabledWhen：可选，引用本插件 boolean 设置，或使用[条件函数](conditions.md)引用；函数按原调用任务在执行前求值。
- instructions：可选使用指引，最长 8000 字符；`{{<plugin-id>.tool}}` 替换为实际工具名，不硬编码运行时名称。
- tools：`[{id,title,description,parameters}]`，最多 16 个，必须在 activate 中全部注册。
- actions：`[{id,title,triggers,enabledWhen?}]`，最多 16 个，必须在 activate 中全部注册。只提供动作时可以省略 tools；tools 与 actions 至少提供一项。

parameters 为封闭对象，例如：`{type:"object",properties:{summary:{type:"string",description:"任务摘要"}},required:["summary"],additionalProperties:false}`。支持最多 16 个 string/number/boolean 字段，不支持嵌套 schema 或外部引用。

```ts
context.agent.registerTool(`${context.extension.id}.tool`, async (input, invocation) => {
  const configuration = await context.configuration.get()
  const task = await invocation.task.get()
  if (task.titleSource === 'manual' || task.titleSource === 'legacy')
    return { applied: false }
  const result = await invocation.models.generateText({
    prompt: String(input.summary),
    model: typeof configuration.model === 'object' ? configuration.model : null,
    maxTokens: 256,
  })
  return invocation.task.rename({ title: result.text.trim() })
})
```

工具由主模型选择调用，回调返回 JSON，生命周期属于原运行。需要随输入提交、对话完成或菜单点击执行时，使用下面的任务动作。

## 任务动作

动作不依赖主模型决定是否调用，不占用主对话的工具消息。以下是一个只读取任务信息的最小声明；将 `example.helper` 替换为插件实际 ID：

```json
{
  "permissions": { "agent": true, "tasks": "read" },
  "contributes": {
    "agent": {
      "actions": [{
        "id": "example.helper.inspect",
        "title": "检查任务",
        "triggers": ["task:input:committed", "task:turn:completed", "user"]
      }]
    }
  }
}
```

```ts
context.agent.registerAction(`${context.extension.id}.inspect`, async (invocation) => {
  const task = await invocation.task.get()
  return { status: 'completed', message: task.title ?? '未命名任务' }
})
```

每种触发的字段、时机和类型收窄方式只在 [任务动作事件列表](events.md#任务动作事件) 维护。包含 `user` 时宿主自动将动作放入任务菜单，不必另外声明普通菜单命令；插件不能自行制造 `user` 调用或传入另一个任务 ID。actions 的 title 是 1–100 字符的菜单显示文本。

回调返回 `{status:'completed'|'skipped', message?:string}`，message 最长 500 字符。`skipped` 表示当前无需执行，不是失败。动作在对应回复的工具调用流程中显示进度、状态及结果，即使在回复完成后才开始执行，也归入该回复的流程。自动 skipped 不显示，用户主动触发的 skipped 保留原因；没有可关联回复时单独显示工具调用流程。调用记录和用量始终保留。新记录随所属分支持久化，不产生主模型工具消息；升级前缺少分支信息的调用不会补造历史。主对话结束不会取消独立动作；动作失败也不使已完成的主对话失败。所有调用句柄仅在本次回调内有效；遵守 `invocation.signal`，不保留给其他任务或后台定时器。配置变化、插件禁用、更新或崩溃会撤销该插件的相关调用。

自动命名可以在输入提交后处理 `fallback` 标题，成功后保留 `generated` 标题；上下文不足时返回 skipped，下一次输入仍可重试。需要随目标变化更新时，通过插件设置控制完成事件的处理；默认成功命名一次即可，避免轻微追问反复改名。`user` 动作可实现“重新生成标题”，允许替换原有手动或历史标题。

## 模型与任务权限

`permissions.models: true` 开放 `invocation.models.generateText({prompt,system?,model?,maxTokens?})`，返回 `{text,model}`。未指定模型时，工具继承原运行的模型，动作使用调用开始时的任务模型选择或对应输入的对话模型；没有可用模型时失败。请求仅有文本，没有工具或隐式对话历史；不允许自定义凭据、URL 或 Provider 参数。凭据留在宿主。工具用量计入原运行，动作用量属于独立调用，同样出现在任务用量统计中。每次调用最多 4 次模型请求，同时最多 1 次，每次最多 4096 输出 token，整次调用限时 120 秒。

`permissions.tasks: "read"` 开放 `task.get()`，返回当前任务的 id/title/titleSource。titleSource 为 `fallback`（消息截取）、`generated`（生成）、`manual`（用户明确命名）或 `legacy`（历史来源未确认）。`"title"` 额外开放 `task.rename({title})`，标题为单行 1–80 字符，返回 `{applied}`。宿主捕获本次调用开始时的标题版本，只接受该版本上的更新；重新读取标题不会刷新写入资格。自动动作与工具不能覆盖 manual/legacy，只有从任务菜单显式发起的 user 动作可以替换，期间的并发修改仍受保护。改名不更新任务活动时间。

过期标题写入返回 `{applied:false}`，任务或调用已失效则拒绝请求。版本比较由宿主负责，插件不需要读取或传递版本号。

`permissions.taskMessages: true` 单独开放 `task.messages()`，返回当前任务可见分支的有界 `{role:'user'|'assistant',text}` 数组，最多 16 条、每条最多 1500 字符。当前保留首条用户输入与最近文本；不包含工具输出、隐藏分支、附件正文或隐式文件读取。仅在任务消息确实是功能输入时申请此权限，不因需要标题就申请。

以上接口均绑定原任务，不接受任意任务 ID，也不提供任意字段或数据库写入。宿主和其他插件仍可通过各自授权入口修改同一任务，过期结果不能覆盖新状态。
