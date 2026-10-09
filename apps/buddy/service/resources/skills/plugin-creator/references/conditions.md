# 条件函数

API 3 的 `conditions` 能力用于声明式设置及 Agent 入口的可用性判断。先查询宿主 runtime 能力目录；旧宿主即使同为 API 3，也可能不支持此能力。

## 声明与注册

清单只引用函数 ID 和 JSON 参数，不放函数字符串或表达式代码。函数在插件沙箱的 `activate` 中注册，不能在视图或条件回调中动态注册。

```json
{
  "contributes": {
    "conditions": [{ "id": "example.helper.available", "inputs": ["configuration", "form"] }],
    "settings": {
      "items": [{
        "id": "example.helper.mode",
        "key": "mode",
        "group": "settings.general.general",
        "title": "模式",
        "type": "string",
        "default": "",
        "enabledWhen": { "condition": "example.helper.available", "params": { "requiredKey": "enabled" } }
      }]
    }
  }
}
```

示例中的 enabled 需另声明为 boolean 设置；启用开关自身不要依赖这个条件。

```ts
context.conditions.register('example.helper.available', (ctx, params) => {
  const current = ctx.form.status === 'available' ? ctx.form : ctx.configuration
  return current.status === 'available'
    && typeof params.requiredKey === 'string'
    && current.values[params.requiredKey] === true
})
```

回调接受只读 `ConditionContext` 与只读 params，可同步或异步返回 boolean 或 `{value:boolean, reason?:string}`。reason 最长 300 字符，供用户理解不可用原因，不放诊断堆栈或敏感信息。最多声明 32 个条件，参数总大小不超过 16 KiB。没有外部数据依赖时 inputs 可以为空。

设置项、`agent.enabledWhen` 和单个 `agent.actions[].enabledWhen` 接受相同引用。Agent 的字符串 enabledWhen 仍是 boolean 配置 key 的简写，可直接控制贡献是否出现在目录中；函数条件依赖调用作用域，在实际执行前求值，不按设置页或全局焦点过滤工具目录。函数返回 false 时动作 skipped、工具拒绝执行；条件求值失败同样不执行。UI 的禁用状态不授予权限，也不能替代任务写入时的版本、分支与授权检查。

## 上下文

`version: 1` 标识上下文契约。`scope.configuration` 表示配置归属；目前仅提供 global，类型预留 space/task，尚无覆盖层级。`scope.invocation` 独立表示 settings（moduleId/groupId）或 task（taskId/runId）；后台动作的 runId 为 null。`target` 是本次求值的 setting/agent/action 及 ID。`scope.key` 是不透明的作用域标识，可用于精确失效，不解析其格式。

每个数据源均带 status；available 才能读取 revision 和数据。revision 为不透明内容版本，不保证递增。未声明输入为 not_requested；无任务或表单上下文为 no_context；权限不足为 denied；宿主缺少能力为 unsupported；Runtime 暂不可用为 loading；无效配置或失效任务为 invalid。它们都不是 false，也不是空列表，插件需要显式决定这些状态下的行为。

| inputs | available 数据 | 权限与范围 |
| --- | --- | --- |
| configuration | values、每个 key 的 sources | 自己当前已保存的有效配置，含默认值；当前 sources 均为 global |
| form | values、dirtyKeys | 设置页已保存值叠加当前编辑草稿；不是持久配置，任务调用没有 form |
| runtime.models | selection、models | 需要 models 权限；模型 ID、显示名、可用性、能力。工具使用原运行模型、动作使用原任务当前模型，设置页使用默认模型；无凭据或请求地址 |
| runtime.task | id、spaceId、branchId、title、titleSource、activity、modelSelection | 需要 tasks 权限；仅原调用任务，不随用户切换焦点；设置页不隐式读取最近任务，无消息正文 |
| workbench | panes 的 id、active、visible | 仅分屏概要，无 DOM、文件路径、输入内容或任务关联 |

异步函数收到的是本次一致的只读快照，不是可变全局对象。配置、模型目录、任务状态、分屏或草稿变化后，宿主使相关结果失效；设置页自动重算，实际任务入口重新判断。入口检查因上下文持续变化被撤销时按取消处理，不记为动作失败。`signal` 在本次结果过期、取消或宿主停止时撤销。应尽快返回，只做判断，不在条件中改设置、发通知或调用模型。

插件自己的内存或业务状态变化后，可调用 `context.conditions.invalidate({condition?,scopeKey?})`；省略参数使本插件所有条件失效，不影响其他插件。不要在求值函数内调用 invalidate，也不要轮询刷新。

宿主合并相同的在途设置求值并有界缓存结果，数据版本、参数、目标与作用域不同不会共享结果。沙箱函数预算 2 秒，包含快照读取的宿主等待最多 5 秒；超时、异常或非法返回值使该项暂不可用，并允许用户重试。数据变化、禁用、更新和宿主退出会撤销过期结果。不符合新版本的旧配置保留原值，并允许逐项修复或恢复默认值。
