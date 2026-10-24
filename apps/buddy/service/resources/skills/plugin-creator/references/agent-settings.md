# Agent 工具、任务动作与设置

这些是 API 3 的增量能力。先查询当前宿主的 `runtime` 能力目录，确认所需的 `agent.tools`、`agent.actions`、`agent.models`、`agent.task`、`agent.taskMessages`、`agent.references` 或 `settings` 可用，再声明对应的最低 `engines.lexora`。相同 API 版本的旧宿主不一定提供全部增量能力。

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
- instructions：可选使用指引，最长 8000 字符；`{{<plugin-id>.tool}}` 替换为实际工具名，不硬编码运行时名称。 保留简短的工具使用约束；可复用工作流程与较长参考资料放入独立的 [插件 Skills](skills.md)，不会自动拼入此字段。
- tools：`[{id,title,description,parameters,access?}]`，最多 16 个，必须在 activate 中全部注册。
- actions：`[{id,title,triggers,enabledWhen?,execution?}]`，最多 16 个，必须在 activate 中全部注册。只提供动作时可以省略 tools；tools 与 actions 至少提供一项。

`access` 支持 `read`（默认）和 `write`。改变文档或其他业务数据的工具必须声明 `write`，由当前执行档和审批策略判定；该字段不授予文件路径、编辑器或其他宿主能力。

parameters 为封闭对象，例如：`{type:"object",properties:{summary:{type:"string",description:"任务摘要"}},required:["summary"],additionalProperties:false}`。每层 object 最多 16 个字段，所有 object 都是 `additionalProperties:false`；字段支持 string/number/boolean、object 和 array。根对象之外最多 4 层容器，整个 schema 最多 128 个节点、32 KiB，不支持 `$ref`、联合类型或开放对象。string 可声明 `enum/minLength/maxLength`（默认最多 32768 字符），number 可声明 `enum/minimum/maximum`，array 使用 `items/minItems/maxItems`（maxItems 默认 128、上限 256）。enum 最多 64 项。单次输入整体最多 256 KiB；超大文档应分页读取、分批修改。已有平铺声明保持兼容。

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

工具上下文的 `scope` 是宿主绑定的 `{taskId,branchId,runId}`，不需要 tasks 读取权限；插件不能传入或替换目标。它只表示此次执行归属，不提供额外任务或文件读取权。

`invocation.artifacts.publish({resource:{id},name?})` 将本插件私有资源复制到当前工作区 `outputs/<unique-id>/<name>`，返回 `{id,name,mimeType,size}` 并显示正常任务产物卡片。仅 `access:"write"` 工具可调用；支持 createFile/importFile/download 得到的私有资源，不直接发布用户文件选择句柄或包内路径。单文件最多 64 MiB，每次工具最多 8 个；不能覆盖已有文件或指定磁盘路径。产物独立于插件私有文件，释放原资源不会移除产物。

`await invocation.results.addImage({resource:{id}})` 把私有 PNG/JPEG/WebP 加入本次工具的原生模型图片结果，工具仍返回普通 JSON 业务结果。单图最多 8 MiB/25 百万像素，每次工具最多 4 张、源文件合计最多 16 MiB；宿主校验并缩放至最长边 2000 像素、单图最多 2 MiB。不要把 base64 放进返回 JSON。此方法不发布产物；需要用户可下载的图时另行 publish。工具抛错时不交付图片；已经成功发布的产物仍保留。调用取消、插件停用/更新或任务分支失效会拒绝后续读取和交付。

以上三个能力仅 `AgentToolContext` 提供，后台动作不提供。嵌套 schema、scope、产物发布和图片结果要求 `engines.lexora: ">=0.15.0"`。


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

`permissions.models: true` 开放 `invocation.models.generateText({prompt,system?,model?,maxTokens?})`，返回 `{text,model}`。未指定模型时，工具继承原运行的模型，动作使用调用开始时的任务模型选择或对应输入的对话模型；没有可用模型时失败。请求仅有文本，没有工具或隐式对话历史；不允许自定义凭据、URL 或 Provider 参数。凭据留在宿主。工具用量计入原运行，动作用量属于独立调用，同样出现在任务用量统计中。每次调用最多 4 次模型请求，同时最多 1 次，每次最多 4096 输出 token；取消由调用任务或 AbortSignal 控制，不设整次调用的固定时长配额。

模型输出达到长度上限时，Promise 拒绝，`error.message` 为 `EXTENSION_MODEL_TRUNCATED`，不会返回不完整的文本；模型返回失败或中止结果时为 `EXTENSION_MODEL_FAILED`。已产生的用量仍会记录。插件可捕获截断错误，在请求额度内调整 `maxTokens` 或缩短输入后重试；宿主不会自动重试。调用被取消或任务已失效时，以取消或失效结果为准。

`permissions.tasks: "read"` 开放 `task.get()`，返回当前任务的 id/title/titleSource。titleSource 为 `fallback`（消息截取）、`generated`（生成）、`manual`（用户明确命名）或 `legacy`（历史来源未确认）。`"title"` 额外开放 `task.rename({title})`，标题为单行 1–80 字符，返回 `{applied}`。宿主捕获本次调用开始时的标题版本，只接受该版本上的更新；重新读取标题不会刷新写入资格。自动动作与工具不能覆盖 manual/legacy，只有从任务菜单显式发起的 user 动作可以替换，期间的并发修改仍受保护。改名不更新任务活动时间。

过期标题写入返回 `{applied:false}`，任务或调用已失效则拒绝请求。版本比较由宿主负责，插件不需要读取或传递版本号。

`permissions.taskMessages: true` 单独开放 `task.messages()`，返回当前任务可见分支的有界 `{role:'user'|'assistant',text}` 数组，最多 16 条、每条最多 1500 字符。当前保留首条用户输入与最近文本；不包含工具输出、隐藏分支、附件正文或隐式文件读取。仅在任务消息确实是功能输入时申请此权限，不因需要标题就申请。

以上接口均绑定原任务，不接受任意任务 ID，也不提供任意字段或数据库写入。宿主和其他插件仍可通过各自授权入口修改同一任务，过期结果不能覆盖新状态。

## 工具中的用户引用

声明 `permissions.references: true` 后，工具回调可用 `invocation.references.list()` 获取 `{items:[{referenceId,sourceMessageId,title,excerpt}],truncated}`。列表最多保留最近 100 条本插件消息引用快照，excerpt 最长 512 字符；引用来自当前运行已经提交的用户输入及同一可见分支的历史用户输入，因此对话压缩不影响引用身份。不同任务、隐藏分支、其他插件、助手与工具生成的引用不在范围内。未发送草稿和当前运行尚未接受的新输入不授予资格。任务动作不提供该 API。

`invocation.references.resolve(referenceId, {sourceMessageId?,offset?,limit?})` 返回 `{referenceId,sourceMessageId,title,text,textLength,textDigest,offset,nextOffset,locator,scope:{taskId,branchId}}`，locator 为插件原始定位信息或 null。`text` 为 UTF-16 单元分页，不切断代理对；起点落在代理对中间时拒绝读取，默认 offset 为 0，limit 默认为 32768、最大 32768；nextOffset 为 null 表示已到末尾。textLength 是完整快照长度，textDigest 是完整原文 UTF-8 字节的 SHA-256，不是当前页摘要。长引用按需读取；定位验证可使用完整快照摘要与长度，不要把第一页误当全文。sourceMessageId 指向携带这份引用快照的用户消息，referenceId 是宿主生成的引用 ID，不是消息里的引用序号。将两者一起保留并传给 resolve；同一个 referenceId 可出现在多条消息中。旧调用省略 sourceMessageId 时，仅在所有匹配快照完全相同时兼容，否则返回 EXTENSION_REFERENCE_AMBIGUOUS，须从列表选择精确消息身份。已知的历史 ID 即使不在最近 100 条列表中也可解析。引用本身不授予读取任意文件或修改文档的能力。任务结束、取消、输入或分支变更后，旧调用失效。

插件应只向模型返回适量文字、referenceId 和 sourceMessageId，将 locator 留在插件内处理。编辑前重新解析引用，核对目标文档、会话和版本，使用现有视图消息与命令回执完成操作；不要按当前焦点选择目标，也不要把复制来的文本当作新的引用授权。新能力通过当前宿主的 runtime 目录确认，并按实际宿主版本声明兼容范围。
