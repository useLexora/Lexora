# 插件清单与兼容性

插件由根目录 `extension.json` 和包内文件组成。先用 [能力选择](capabilities.md) 确定入口与状态归属，再阅读本页和涉及的专题。[完整 API 类型](api.d.ts) 给出准确签名。

## 清单

清单结构如下；按需求补齐 `contributes`、入口和权限，空清单只是结构说明，不能作为成品交付。能力组合见 [能力选择](capabilities.md)。

```json
{
  "schemaVersion": 1,
  "format": "source",
  "id": "<plugin-id>",
  "name": "插件名称",
  "author": "作者署名",
  "description": "插件完成的用户行为。",
  "version": "1.0.0",
  "apiVersion": 4,
  "engines": { "lexora": ">=0.16.2" },
  "permissions": {},
  "contributes": {}
}
```

`<plugin-id>` 是占位符，填写时必须替换为新插件身份工具返回的 ID，或正在维护的源码清单中的既有 ID；后续声明中的占位符同样替换。宿主代码通过 `context.extension.id` 引用当前插件，不复制示例身份。作者署名 `author` 可选，支持 Unicode，最多 80 个用户可见字符，不含换行或控制字符；留空表示未署名。不符合规则时说明原因，给出候选并通过对话确定，不静默截断或替换。作者与显示名可变，ID 和末尾的调用名保持稳定。使用作者字段的包要求 Lexora 0.9.0 或更新版本。

可选字段：`author`、`icon`（包内 SVG/PNG/JPEG/WebP，≤64 KiB）、`categories`、`tags`、宿主 `entry`、`dataVersion`。不要添加未定义的字段。命令、视图和挂载声明的 ID 以插件 ID 加 `.` 开头且不重复。文件路径相对包根，不能包含 `..` 或符号链接；最多 4096 个文件，其中非图片文件最多 512 个；归档最多 8192 个条目。单文件最多 64 MiB，压缩安装包最多 128 MiB，展开文件合计最多 256 MiB；目录安装、市场下载与构建使用相同预算。对话构建自动分块传输安装包，每块最多 256 KiB，不要把大包或二进制资源塞进普通 JSON 消息。源码编译仍受时间与内存限制，大型预构建 JS 库应使用 compiled 包。

`contributes` 内的声明结构如下。省略不用的项；每项权限和运行方式见对应专题，无需查找应用实现或复制某个示例清单。

| 字段 | 结构 |
| --- | --- |
| `commands` | 数组，每项必填 `id`、`title`；`hidden` 可选，默认 false；API 3 可声明 `slash: {name, description?}`，规则见 [注册命令](commands.md)。存在命令时必须设置清单顶层的宿主 `entry` |
| `menus` | API 3；数组，每项必填 `id`、`command`、`target`，可选 `order`（-1000 至 1000，默认 0）、`when`；引用自己的已声明命令 |
| `views` | 数组，每项必填 `id`、`title`、`entry`；`resource` 为 `selected-file`（默认）、`none`，或 API 4 的 `optional-file`；`location` 默认 `context`；`stateVersion` 为正整数，默认 1 |
| `placements` | 数组，每项必填 `id`、`view`、`kind`，并按 kind 添加[视图与挂载](views.md)规定的 `anchor`、`target` 或 `presentation`；不要把它们写入视图定义 |
| `navigation` | 单个对象，必填 `title`、`view`，引用自己的无资源视图 |
| `fileHandlers` | API 4；数组，每项必填 `id`、`title`、`extensions`；`preview`、`open` 至少提供一个，各含 `view` 和可选 `requestDefault`（默认 `true`）；见 [文件关联](resources.md#文件关联与独立入口) |
| `launchers` | API 4；数组，每项必填 `id`、`title`、`view`，提供无需文件的独立入口 |
| `skills` | API 4；数组，每项为 `{id,path}`，path 指向包内 `SKILL.md`；可独立提供，无需 entry 或额外权限，见 [插件 Skills](skills.md) |
| `agent` | API 3；指令、工具、任务动作和可选的 enabledWhen，见 [Agent 工具与动作](agent.md) |
| `settings` | API 3；声明 modules/groups/items，由宿主渲染并保存，见 [声明式设置](settings.md) |
| `shells` | API 4；固定本机解释器候选与原生设置映射；可选 settingsGroup 将插件自有组渲染为一行一个 Shell 的原生表格，文件选择仅限原生设置，需独立 shells 权限，见 [命令解释器](shells.md) |

插件 ID 使用小写字母开头的两段名称，中间以 `.` 分隔，每段可含小写字母、数字与 `-`；贡献 ID 在插件 ID 后追加由小写字母、数字、`.`、`-` 组成的后缀。声明文件路径使用包内相对路径，`.ts` 文件名直接指向源码，编译工具负责产出运行文件。


## 包格式与版本

- `format: "source"`：自包含 TS/JS 与包内相对导入，由宿主固定编译器处理；原始 HTML、Vue 单文件组件和 npm 裸导入不属于该编译协议。
- `format: "compiled"`：作者预先构建浏览器模块及其资源。Vue、React 和其他第三方库可在作者工程中使用，交付包保留其已编译结果；安装时不运行依赖安装或构建脚本。
- `version` 标记插件版本；`apiVersion` 标记协议主版本；`engines.lexora` 标记实际支持的宿主版本范围。API 4 内的增量接口仍可能要求更新的宿主，不能仅凭主版本声明兼容。
- `dataVersion` 对应插件私有数据迁移，视图 `stateVersion` 对应实例状态迁移，详见 [生命周期与状态](lifecycle.md)。升级维持插件和贡献 ID，保留用户数据。

示例版本仅用于说明清单结构。采用文件编辑、引用捕获等新增能力时，以对应专题和实际验收的宿主为准。

## 专题索引

| 开发目标 | 阅读资料 |
| --- | --- |
| 后台入口、通信与状态 | [生命周期](lifecycle.md) |
| 页面、面板、文件标签、剪贴板 | [视图与挂载](views.md) |
| 命令、菜单、通知、定时 | [命令](commands.md) |
| 文件打开、资源读取与导出 | [文件资源](resources.md) |
| 原件保存、恢复与关闭保护 | [文档编辑](documents.md) |
| 引用到对话、来源定位、工具读取引用 | [引用](references.md) |
| Agent 工具、任务动作和模型调用 | [Agent](agent.md)、[事件](events.md) |
| 原生设置与生效条件 | [设置](settings.md)、[条件](conditions.md) |
| 主题、样式与装饰 | [样式](styles.md)、[主题](themes.md)、[文件图标](file-icon-themes.md) |
| Worker、WASM、插件 Skills、命令解释器 | [计算](workers.md)、[Skills](skills.md)、[Shell](shells.md) |
| 权限与独立开发 | [权限](permissions.md)、[SDK 工作流](sdk-workflow.md) |
