---
title: "文件与文档"
description: "通过统一资源与文档接口实现预览、原件编辑、导出和恢复。"
---

# 文件与文档

文件格式由插件解析。宿主提供授权、内容传输、版本检查和保存生命周期；同一套接口可以用于文本、表格、图片和其他二进制内容。

## 从文件打开插件

API 4 的 `contributes.fileHandlers` 按精确后缀注册处理器，分别声明 `preview` 和 `open`。视图使用 `resource: "selected-file"` 或 `"optional-file"`，并申请 `selectedResource: "read"`。

```json
{
  "fileHandlers": [{
    "id": "example.reader.files",
    "title": "阅读器",
    "extensions": [".md"],
    "preview": { "view": "example.reader.main" },
    "open": { "view": "example.reader.main" }
  }],
  "launchers": [{ "id": "example.reader.start", "title": "阅读器", "view": "example.reader.main" }]
}
```

这是 `contributes` 的片段，需同时声明对应视图，并把示例 ID 换成自己的稳定身份。`launchers` 提供无文件入口，适合 `none` 或 `optional-file` 视图；启动时资源为空，文件打开时资源由宿主传入。

## 读取与生成资源

| 操作 | API |
| --- | --- |
| 选择其他本地文件或目录 | `resources.pickFiles` / `pickDirectory` |
| 读取 UTF-8 文本 | `readText`，最多 1 MiB |
| 分段读取二进制 | `readBytes`，每次最多 128 KiB |
| 图片、音视频和 Range 请求 | `getUrl`，URL 随会话失效 |
| 创建不可变私有文件 | `createFile` |
| 复制已有授权内容到私有文件 | `importFile` |
| 导出到用户确认的位置 | `saveFile` |

保存资源 ID，每次会话重新取得 URL。资源对象不包含任意本机路径。私有版本更新先创建新资源、提交元数据指针，再释放旧资源；失败时保留旧内容。

## 编辑原件与恢复

原件编辑使用 API 4 的 `fileEditing` 与交互视图 `context.documents`。采用这套新增编辑能力的插件应要求 Lexora 0.17.0 或更新版本，并在目标宿主验收。

`EditableDocument` 表示可编辑内容，可以已经绑定磁盘文件，也可以是未保存草稿。格式解析、编辑缓冲区和用户界面由插件管理。

| 阶段 | 操作 | 用户应看到的状态 |
| --- | --- | --- |
| 打开 | `pick()` 或 `open(context.resource)` | 文件已打开，尚未产生修改 |
| 新建 | `create({name,data})` | 未保存内容 |
| 编辑与恢复保障 | `backup(document,{data})` | 有修改，恢复内容已保留 |
| 写回原件 | `save(document,{data})` | 返回成功后显示已保存 |
| 保存到新位置 | `saveAs({name,data})` | 用户确认后取得新的文档身份 |
| 重启恢复 | `list()`、`resume({id})`、`read()` | 让用户选择恢复内容及后续保存方式 |

`version` 表示原件基线，`revision` 表示当前内容版本。每次 backup/save 后使用返回的新句柄。保存检查文件身份和外部修改；冲突时保留恢复内容并提示用户处理，不能强制覆盖。

保存副本可用资源导出，保留当前原件绑定与未保存状态。恢复草稿不意味着原件已保存；AI 修改也应遵循相同规则。

## 关闭与失败

使用 `onBeforeClose(signal => ...)` 等待当前保存队列并明确返回是否允许关闭。取消、异常或超时应保留编辑器；回调不能拦截崩溃或强制停用，因此恢复内容要在正常编辑过程中保存。

授权撤销或原件不可用时，保留的恢复内容仍可读取与另存为；重新访问原件需要授权。保存结果未知时先 resume 核对状态，不自动重放旧操作。

验证正常保存、外部修改冲突、取消、双视图写入、重启恢复和保存副本；以回读文件内容作为保存成功证据。
