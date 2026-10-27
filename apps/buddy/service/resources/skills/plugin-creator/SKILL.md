---
name: plugin-creator
description: 创建、修改并验证可安装的 Lexora 桌面插件，包括视图与面板、文件编辑、Agent 工具与任务动作、配套 Skills、主题、工作台装饰、网络查询和定时命令。也响应 $plugin-creator。普通任务执行、使用现有插件、其他产品的插件开发不属于此技能。
---

# 创建 Lexora 插件

将需求变成可安装、可修改的真实插件。先完成用户需要的最小流程，再依据编译诊断和实际体验迭代；不以占位 demo 代替需求。

## 1. 确定行为与能力

从当前对话确定输入、触发时机、呈现位置、生效范围、持久数据和停止方式。描述充分时直接实施，只询问会改变实现的缺失信息；没有设置需求时优先复用启用、禁用，不额外增加页面。

分别判断事件来自哪里、内容画在哪里和何时可见。保持用户指定范围；指定位置缺少正式能力时说明缺口，不用相近区域或父页面 DOM 模拟交付。外部参考先核对公开资料，再映射到 Lexora 的接口。

读取 [能力选择](references/capabilities.md)。通过 `lexora_tool_search` 查找 `lexora_plugin_capabilities`，先查简短目录，再按 `kind` 或 `target` 查询需要的契约。先说明所选组合能完成的用户行为，不提前加载全部专题。

## 2. 阅读对应契约

读取 [清单与兼容性](references/protocol.md)，按下表补充本次所需专题，并在 [API 类型](references/api.d.ts) 中核对实际使用的接口。继续旧任务时重新读取当前说明和已有源码清单，历史示例不替代当前契约。

| 需求 | 资料 |
| --- | --- |
| 后台入口、视图通信、数据与实例状态 | [生命周期](references/lifecycle.md) |
| 页面、面板、剪贴板、挂载和可见性 | [视图](references/views.md)、[插槽](references/slots.md)、[临时交互](references/interactions.md) |
| 命令、菜单、通知和定时 | [命令](references/commands.md) |
| 文件打开、读取、导出 | [资源](references/resources.md) |
| 编辑原件、恢复草稿、关闭保护 | [文档](references/documents.md) |
| 引用到对话、定位原文、工具解析引用 | [引用](references/references.md) |
| Agent 工具、任务动作、模型调用 | [Agent](references/agent.md)、[事件](references/events.md) |
| 原生设置、配置热应用、条件函数 | [设置](references/settings.md)、[条件](references/conditions.md) |
| 配色、图标、窗口样式和装饰 | [主题](references/themes.md)、[图标](references/file-icon-themes.md)、[样式](references/styles.md) |
| Worker/WASM、插件 Skills、解释器候选 | [计算](references/workers.md)、[Skills](references/skills.md)、[Shell](references/shells.md) |
| 权限或访问失败 | [权限](references/permissions.md) |

纯主题和纯 Skills 包不需要脚本入口。仅声明实际需要的权限，确认能力所属的后台、视图或本次 Agent 调用，不能互换上下文。

## 3. 创建源码并构建

读取 [对话创作与交付](references/authoring.md)，使用当前工作区中的独立目录保留真实源码。新插件通过 `lexora_plugin_identity` 生成身份；维护、升级和署名修改保留现有 ID。署名不从系统账号或目录推断；无效署名或调用名给出候选并让用户确定，不静默替换。

默认编写自包含 TS/JS 和包内资源，复制 API 类型为 `lexora.d.ts` 并仅作 type import。视图导出 `render(context, container)`；确有后台职责时再提供 `activate(context)`。源码包设为 `format: "source"`，无需用户安装工具链。第三方库需先构建为浏览器可用的 compiled 包，不能运行时导入 npm 或 CDN。

通过 `lexora_plugin_build` 构建，依据诊断修复。安装走用户可见的确认流程；构建结果中的审核状态不等于已安装。需要核实版本、待应用更新或加载错误时使用 `lexora_plugin_inspect`。确在用户提供的独立 SDK 环境中开发时，改读 [SDK 工作流](references/sdk-workflow.md)。

## 4. 验证与交付

检查所需行为、状态恢复、关闭与停用，以及相应的取消和失败路径。文件编辑必须区分草稿、原件保存和导出；异步操作固定发起时的资源、视图和调用，不能用后来焦点选择目标。订阅、定时器与 Worker 按各自生命周期释放。

编译通过和视图 ready 只证明各自阶段。能操作真实插件界面时实际验证；否则明确待体验项，不能用普通浏览器模拟宿主后声称插件验收通过，也不编造截图或效果。等待安装确认时不循环轮询。

通过 `lexora_output_present` 交付源码和安装包，简述入口、已检查行为与待验证项。后续修改读取已有源码并保留身份和数据含义；市场发布或远端同步遵循用户指示。构建、诊断和验收的详细步骤统一见 [创作流程](references/authoring.md)。
