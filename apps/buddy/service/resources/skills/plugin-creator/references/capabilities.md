# 按需求选择插件能力

先决定输入来自哪里、用户在哪里操作、关闭页面后是否继续运行、哪些状态需要恢复。下表用于选路；字段、权限、限制和示例由对应专题维护，准确签名见 [API 类型](api.d.ts)。一个插件可以组合多个能力。

## 界面与交互

| 用户目标 | 选择 | 深入阅读 |
| --- | --- | --- |
| 打开独立页面或文件标签 | `views`、`navigation`，按需要选择资源模式 | [视图](views.md) |
| 在工作台或分屏显示面板 | `placements` 的 `view` 与 `presentation` | [挂载](views.md#正式挂载点) |
| 替换或追加宿主内容 | `slot`、`control`，使用正式目标与真实默认回退 | [插槽](slots.md) |
| 读取或观察绑定范围的统计与上下文用量 | `ViewContext.data.read/observe` 与逐来源 `permissions.data`；呈现位置另选 | [只读数据](data.md) |
| 输入命令或点击业务菜单 | `commands`、`slash`、`menus` | [命令](commands.md) |
| 临时覆盖交互、布局订阅 | `interactions` 与宿主布局快照 | [交互](interactions.md) |
| 复制粘贴、显示文档名和修改状态 | 交互视图的 `clipboard`、`setDocumentInfo` | [视图](views.md#视图类型) |
| 配色、欢迎内容、图标、窗口装饰 | 声明式主题或窗口样式、独立装饰视图 | [主题](themes.md)、[图标](file-icon-themes.md)、[样式](styles.md) |

## 文件与内容

| 用户目标 | 选择 | 深入阅读 |
| --- | --- | --- |
| 为指定后缀提供预览或编辑入口 | `fileHandlers`；无文件入口用 `launchers` | [文件关联](resources.md#文件关联与独立入口) |
| 读取用户选择的文件、目录或远端文件 | `resources`，远端使用受控 `network` | [资源](resources.md) |
| 生成私有二进制、导出副本 | `resources.createFile`、`saveFile` | [资源与导出](resources.md#本地资源与导出) |
| 编辑原件、保存草稿、处理冲突与恢复 | `fileEditing` 与交互视图 `documents` | [文档编辑](documents.md) |
| 将材料放入任务草稿、定位原文 | 视图 `references`，工具按调用资格解析引用 | [引用](references.md) |
| 执行 WASM、解析二进制或密集计算 | 浏览器 WASM 与 `workers.create` | [Worker](workers.md) |

## Agent 与后台

| 用户目标 | 选择 | 深入阅读 |
| --- | --- | --- |
| 让主模型主动调用插件 | `agent.tools`，声明读写类别 | [Agent](agent.md) |
| 输入、完成事件或任务菜单触发动作 | `agent.actions` 与精确触发声明 | [动作](agent.md#任务动作)、[事件](events.md) |
| 请求已配置模型、读取当前任务 | 本次调用的 `models` / `task`，按权限开放 | [模型与任务](agent.md#模型与任务权限) |
| 提供可搜索的工作方法与配套资源 | `contributes.skills` | [Skills](skills.md) |
| 提供由宿主管理认证与启用的远端连接 | `contributes.mcpConnectors`，可独立声明 | [MCP 连接](mcp-connectors.md) |
| 提供可由伙伴调用的专业 NPC | `contributes.subagents`，可独立声明 | [伙伴：NPC](buddies.md) |
| 原生设置与实时生效条件 | `settings`、`configuration`、`conditions` | [设置](settings.md)、[条件](conditions.md) |
| 关闭页面后仍通知或定时执行 | 后台命令、`notifications`、`schedules` | [命令](commands.md#通知与定时命令) |
| 检测用户已有命令解释器 | 声明式 `shells`；运行仍归宿主 | [Shell](shells.md) |

## 状态归属与验收

后台入口、视图、私有业务数据、声明式配置和每个标签的状态分别归各自作用域，见 [生命周期与状态](lifecycle.md)。共享状态通过自己的命令和广播同步；异步结果绑定原实例，不根据后来焦点选择目标。

验证实际用户流程。例如阅读器检查两份文件的状态独立与重开恢复，设置检查即时生效和重启恢复，编辑器检查草稿、原件与取消，插槽检查撤回后的宿主默认内容。缺少核心能力时明确说明，不通过宿主内部接口或相近位置模拟交付。
