# 注册命令

API 3 可将既有命令公开为输入框 `/插件名:命令`。先声明，再在 `activate` 中通过 `context.commands.register(id, handler)` 注册；命令面板、菜单、视图调用与 Slash 共用同一处理函数。

```json
{ "id": "local.example.start", "title": "开始", "slash": { "name": "start", "description": "开始一次交互" } }
```

```ts
export function activate(context: ExtensionContext) {
  context.commands.register('local.example.start', async ({ arguments: args, invocation }) => {
    if (invocation?.target === 'slash') {
      // args 是用户显式输入的参数字符串，instanceId 是发起分屏。
      await start(args as string, invocation.instanceId)
    }
  })
}
```

名称是插件内的本地名称，宿主使用插件 ID 中发布者后面的名称作为命名空间，例如 `local.example` 的命令为 `/example:start`。中文显示名称不参与匹配。顶级 `/review`、`/compact`、`/skills`、`/status` 等只归系统所有；插件可声明本地 `review`，但只能通过 `/example:review` 调用，不生成顶级短别名。

本地命令名长度为 1–64，匹配 `[a-z][a-z0-9-]*`：英文小写字母开头，后续允许数字和连字符。`title` 和 `description` 用于中文说明。包内本地名称唯一，隐藏命令不能声明 Slash；非法清单在编译或安装时拒绝，不自动修正或改名。不同插件命名空间内可使用同一命令名；如果两个发布者使用相同插件名并都提供 Slash，后启动的插件报命名空间冲突，需修改插件名。

每个声明必须在 `activate` 完成前注册一次。未知 ID、重复注册、非函数处理器或缺少注册都会使该插件启动失败；捕获注册错误也不能使错误插件启动。修正后显式重启。

候选按前缀显示；选中只插入命令，确认发送才执行。执行严格匹配完整名称和大小写，参数保持为字符串，不自动解析引号、JSON 或自然语言。插件本地命令不依赖模型配置，可以在任务流式输出时执行。只传命令参数与发起分屏，不传输入框附件、引用、会话身份或历史；带这些内容时拒绝执行并保留草稿。命令不可用或失败时也保留草稿，不降级为模型提示。

`invocation.target` 为 `slash`，`resource` 为 null，`arguments` 为最多 8192 字符的参数字符串。命令面板调用仍提供既有资源语义且参数为空；视图调用的参数仍为 JSON。插件应按实际调用入口验证自己的参数。

停止覆盖交互不能只依赖 Slash；参见 [交互会话](interactions.md) 的宿主退出机制。
