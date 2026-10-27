---
title: "引用与来源定位"
description: "把插件材料交给任务草稿，并让用户和 Agent 找回准确来源。"
---

# 引用与来源定位

引用保留用户选择时的材料快照，并连接到插件中的来源位置。添加引用不会保存源文档、发送消息或自动调用模型。

## 添加材料

交互视图声明 API 4 的 `references: true` 后可调用：

```ts
const accepted = await context.references.add({
  kind: 'content',
  title: '选中的段落',
  text: selectedText,
  locator: { version: 1, data: { documentId, paragraphId } },
})
```

宿主让用户选择已有任务草稿、新任务或复制引用。成功返回 true，取消返回 false。整份文件使用 `{kind:'resource', resource}`，传递已有授权句柄。

`text` 保存文字快照；`locator` 是插件定义的有界 JSON。它描述位置，不是文件路径授权。引用默认绑定当前资源；内容已由插件独立管理时，`none` 或 `optional-file` 视图可显式使用 `source: 'view'`。

## 定位回原文

注册 `context.references.onReveal(handler)`，核对定位版本与内容后再滚动、选中或展示来源，实际成功后返回 true。

```ts
context.references.onReveal(async ({ locator, text }, signal) => {
  if (!locator || locator.version !== 1)
    return false
  return revealSelection(locator.data, text, signal)
})
```

这里的 `revealSelection` 由插件实现。异步定位尊重 signal，无法恢复原文时返回 false。原件不可访问时，已保存的引用文字仍可查看。

## 自有菜单中的引用

需要在编辑器菜单中呈现目标时，Lexora 0.17.0 起可使用 `capture → commit/release`。capture 固定当时的材料和可接收草稿；点击后提交所选目标，关闭菜单时释放。捕获不能跨视图或重启复用，也不能改投后来激活的任务。

## Agent 读取与编辑

工具回调中的 `invocation.references.list/resolve` 只能解析本插件在原运行可见范围内的已提交用户引用。未发送草稿、其他分支、其他插件和助手生成的材料不授予同样资格；任务动作没有此接口。

保留 `referenceId` 和 `sourceMessageId`，解析时一起传入。长内容按页读取，`textLength` 和 `textDigest` 对应完整快照。不要把第一页当成全文，也不要把 locator 直接暴露为模型指令。

编辑前再次核对引用资格、目标文档、视图会话和内容版本。使用发起时的目标，避免切换焦点后修改另一份文件；引用本身不授予文档编辑权。
