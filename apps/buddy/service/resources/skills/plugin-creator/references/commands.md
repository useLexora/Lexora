# 注册命令

API 3 可将既有命令公开为输入框 `/插件名:命令`。先声明，再在 `activate` 中通过 `context.commands.register(id, handler)` 注册；命令面板、菜单、视图调用与 Slash 共用同一处理函数。

`<plugin-id>` 使用 [清单](protocol.md#清单) 中确定的实际 ID。

```json
{ "id": "<plugin-id>.start", "title": "开始", "slash": { "name": "start", "description": "开始一次交互" } }
```

```ts
export function activate(context: ExtensionContext) {
  context.commands.register(`${context.extension.id}.start`, async ({ arguments: args, invocation }) => {
    if (invocation?.target === 'slash') {
      // args 是用户显式输入的参数字符串，instanceId 是发起分屏。
      await start(args as string, invocation.instanceId)
    }
  })
}
```

名称是插件内的本地名称，宿主使用插件 ID 最后一个点后面的稳定调用名作为命名空间，例如 ID 末段为 `example` 时，命令为 `/example:start`。中文显示名称不参与匹配。顶级 `/review`、`/compact`、`/skills`、`/status` 等只归系统所有；插件可声明本地 `review`，但只能通过 `/example:review` 调用，不生成顶级短别名。

本地命令名长度为 1–64，匹配 `[a-z][a-z0-9-]*`：英文小写字母开头，后续允许数字和连字符。`title` 和 `description` 用于中文说明。包内本地名称唯一，隐藏命令不能声明 Slash；非法清单在编译或安装时拒绝，不自动修正或改名。不同插件允许相同调用名并同时运行。输入候选展示插件名称和作者，选中后绑定稳定命令 ID；纯文本有多个匹配时保留输入并让用户选择，不能默认执行第一个，也不要求安装时改名。

每个声明必须在 `activate` 完成前注册一次。未知 ID、重复注册、非函数处理器或缺少注册都会使该插件启动失败；捕获注册错误也不能使错误插件启动。修正后显式重启。

插件管理卡片只提供管理和独立页面入口，不提供通用命令按钮。依赖分屏、文件或输入内容的命令应在声明中用 `when` 限定对应场景，并在处理函数中校验需要的上下文。候选按前缀显示；选中只插入命令，确认发送才执行。执行严格匹配完整名称和大小写，参数保持为字符串，不自动解析引号、JSON 或自然语言。插件本地命令不依赖模型配置，可以在任务流式输出时执行。只传命令参数与发起分屏，不传输入框附件、引用、会话身份或历史；带这些内容时拒绝执行并保留草稿。命令不可用或失败时也保留草稿，不降级为模型提示。

`invocation.target` 为 `slash`，`resource` 为 null，`arguments` 为最多 8192 字符的参数字符串。命令面板调用仍提供既有资源语义且参数为空；视图调用的参数仍为 JSON。插件应按实际调用入口验证自己的参数。

停止覆盖交互不能只依赖 Slash；参见 [交互会话](interactions.md) 的宿主退出机制。

## 操作菜单

API 3 的 `contributes.menus` 将已有命令放进业务区域的「更多操作」。先用 `lexora_plugin_capabilities({kind:"menu"})` 查询目标与输入契约，再声明 `{id,command,target,order?,when?}`。`hidden` 隐藏命令面板入口，不隐藏显式声明的菜单。

命令参数中的 `invocation` 包含 `target`、`instanceId`，仅在声明 `selectedContent` 且用户点击对应操作后附带 `content`。文件菜单通过原有 `selectedResource` 权限提供 `resource` 句柄。视图调用自己的命令时 `invocation.target` 为 `view`，只附带该视图的实例标识；命令面板和定时调用的 `invocation` 为空。

输入操作可返回 `{insertText:string}`。宿主在原草稿仍可编辑且内容未改变时，将结果作为纯文本插入原选择位置；更换草稿、编辑内容或关闭视图后忽略迟到结果，不自动发送。其他菜单忽略命令返回值。`when` 支持宿主公开上下文，消息菜单额外提供 `message.role`，文件菜单提供当前 `resource.scheme`；不能用条件读取未公开的数据。


## 通知与定时命令

后台提醒使用 `context.schedules.set({ id, command, enabled, intervalMinutes })`，间隔最少 1 分钟；不要用页面 setInterval 代替跨页面提醒。Lexora 退出后暂停，重启继续，错过的提醒不会补发。


`permissions.notifications` 开放 `context.notifications.show({title,body})`。返回 false 表示没有展示通知；通知仍受应用全局开关和限速约束。
