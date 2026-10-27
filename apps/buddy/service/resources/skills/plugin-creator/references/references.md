# 引用到对话与来源定位

## 引用到对话

API 4 的 `context` 和 `page` 视图可声明 `permissions.references: true`，通过 `context.references.add(input)` 选择任务草稿、新建任务或复制引用。装饰、插槽与替换控件不支持此能力。成功加入草稿或复制引用返回 `true`，取消返回 `false`；授权或资源失效会抛错。等待用户选择没有固定的十秒期限；关闭视图或停用插件会取消请求。此操作不会保存源文档、发送消息或调用模型。

自有内容菜单使用 `references.capture(input)` 冻结材料和当时可接收的任务草稿，返回 `{ id, targets: [{ id, label }], defaultId, clipboard }`；视图不可用时返回 `null`。唯一目标的 `defaultId` 可作为主动作，多个目标由插件在子菜单呈现，同时提供新任务及允许时的复制入口。点击后调用 `references.commit(id, { kind: 'view', id: targetId })`、`{ kind: 'new-task' }` 或 `{ kind: 'clipboard' }`。提交会等待草稿持久化，不设固定十秒期限；成功返回 `true`，失效返回 `false`，不会悄悄选择后来激活的任务。菜单关闭时调用 `references.release(id)`。每个视图只保留最近一次捕获，隐藏、关闭、替换会话或已消费后失效；插件不能持久化或跨视图复用捕获 ID。捕获不保存源文档，也不修改草稿。该交互需要 Lexora 0.17.0 或更新版本。

```ts
await context.references.add({
  kind: 'content',
  title: '汇总表',
  text: selectedText,
  locator: { version: 1, data: { sheet: 'Summary', cells: 'A1:B2' } },
})

context.references.onReveal(async ({ locator, text }, signal) => {
  if (!locator || locator.version !== 1)
    return false
  return revealCells(locator.data, { expectedText: text, signal })
})
```

`content` 保存当时的文字快照；`text` 必须非空，文字最多 262144 个 UTF-16 单位，locator 单独按下述 JSON 预算校验，`title` 最多 512 字符。来源身份由宿主生成，插件不能自报路径或来源 ID。默认绑定视图当前选中的资源，并在引用和定位时复核授权。若内容已导入插件自己的文档库，可显式传 `source: 'view'`，只绑定插件视图与 locator，不再依赖最初打开视图的文件；仅 `resource: 'none'` 或 `'optional-file'` 视图支持，`'selected-file'` 会拒绝。`locator` 可省略，是插件定义的只读 JSON，含正整数 `version` 和 `data`；数据最多 16 KiB、12 层，不允许函数、循环或特殊对象。宿主只负责传回，插件负责版本兼容和验证定位结果，不能把 locator 当作文件授权。短片段直接进入模型上下文，长片段提供预览并由宿主引用工具按需读取保存的快照；locator 与内部目标不会进入模型上下文。每条消息最多 16 条引用，快照合计最多 1048576 个 UTF-16 单位；这些存储限制与模型输入预算独立。

每个视图用 `references.onReveal(handler)` 注册一个定位处理器，返回可 `dispose()` 的注册对象。处理器收到只读的 `referenceId`、原始 `text`、`locator`（未提供时为 `null`）和取消信号；确认内容已定位后返回 `true`。无法找到、版本不支持、未注册或抛错均视为定位失败。异步处理必须遵守 `signal`，避免用户取消后继续滚动或改动界面。

定位优先复用原视图，不重载有效会话；绑定资源的引用会重新检查资源授权。内联预览保留当前未保存快照；原视图已关闭时，默认重新打开现有资源来源；`source: 'view'` 引用则以空资源重开该视图，由插件从自有内容恢复。插件应验证 locator 与当前内容是否匹配。插件停用或来源不可访问时，已保存的引用文字仍可查看。

整份文件使用 `references.add({ kind: 'resource', resource })`，传入 `context.resource` 或本插件已有的授权句柄。Space 来源沿用文件引用，临时快照、产物和其他已授权资源按内容复制为附件；不传路径，不扩大读取权限。读取所需的 `selectedResource` / `localResources` 权限仍需分别声明。使用这些新增 API 4 能力时，`engines.lexora` 的最低版本应覆盖实际支持该能力的宿主。


## 工具中的用户引用

声明 `permissions.references: true` 后，工具回调可用 `invocation.references.list()` 获取 `{items:[{referenceId,sourceMessageId,title,excerpt}],truncated}`。列表最多保留最近 100 条本插件消息引用快照，excerpt 最长 512 字符；引用来自当前运行已经提交的用户输入及同一可见分支的历史用户输入，因此对话压缩不影响引用身份。不同任务、隐藏分支、其他插件、助手与工具生成的引用不在范围内。未发送草稿和当前运行尚未接受的新输入不授予资格。任务动作不提供该 API。

`invocation.references.resolve(referenceId, {sourceMessageId?,offset?,limit?})` 返回 `{referenceId,sourceMessageId,title,text,textLength,textDigest,offset,nextOffset,locator,scope:{taskId,branchId}}`，locator 为插件原始定位信息或 null。`text` 为 UTF-16 单元分页，不切断代理对；起点落在代理对中间时拒绝读取，默认 offset 为 0，limit 默认为 32768、最大 32768；nextOffset 为 null 表示已到末尾。textLength 是完整快照长度，textDigest 是完整原文 UTF-8 字节的 SHA-256，不是当前页摘要。长引用按需读取；定位验证可使用完整快照摘要与长度，不要把第一页误当全文。sourceMessageId 指向携带这份引用快照的用户消息，referenceId 是宿主生成的引用 ID，不是消息里的引用序号。将两者一起保留并传给 resolve；同一个 referenceId 可出现在多条消息中。旧调用省略 sourceMessageId 时，仅在所有匹配快照完全相同时兼容，否则返回 EXTENSION_REFERENCE_AMBIGUOUS，须从列表选择精确消息身份。已知的历史 ID 即使不在最近 100 条列表中也可解析。引用本身不授予读取任意文件或修改文档的能力。任务结束、取消、输入或分支变更后，旧调用失效。

插件应只向模型返回适量文字、referenceId 和 sourceMessageId，将 locator 留在插件内处理。编辑前重新解析引用，核对目标文档、会话和版本，使用现有视图消息与命令回执完成操作；不要按当前焦点选择目标，也不要把复制来的文本当作新的引用授权。新能力通过当前宿主的 runtime 目录确认，并按实际宿主版本声明兼容范围。
