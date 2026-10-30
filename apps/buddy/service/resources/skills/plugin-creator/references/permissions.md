# 权限与隔离

| permissions 字段 | 能力 |
| --- | --- |
| `references: true` | 交互视图向任务草稿添加材料和定位来源；Agent 工具读取本插件的已提交用户引用（API 4） |
| `clipboardRead: true` / `clipboardWrite: true` | 交互视图读取或写入文本与 HTML，读写权限独立 |
| `themeManagement: true` | 校验、预览和保存用户主题；仅声明主题无需此权限 |
| `shells: true` | 声明并检测固定命令解释器候选；执行仍归宿主 |
| `agent: true` | 追加 Agent 指令、可调用工具或任务动作 |
| `models: true` | 工具或动作调用期间请求已配置模型，凭据留在宿主 |
| `tasks: "read" / "title"` | 读取当前任务标题元数据；title 额外允许安全改名 |
| `data: ["task.metrics"]` | 仅读取宿主为当前视图绑定的任务与分支统计；包含任务、分支标识，不含正文、日志或凭据。见 [数据来源](data.md) |
| `data: ["context.usage"]` | 仅读取宿主为当前视图绑定的角色上下文用量；包含任务、分支、角色和可空运行标识，不授予任意任务读取。可与其他已知来源组合，默认均不授予。见 [数据来源](data.md) |
| `taskMessages: true` | 工具或动作调用期间读取原任务可见分支的有限消息文本，详见 [任务权限](agent.md#模型与任务权限) |
| `windowEffects: true` | 窗口 CSS、锚点装饰、窗口效果与无内容的对话输入活动 |
| `controls: ["model.reasoning"]` | 提供可由用户选用的思考等级控件 |
| `notifications: true` | 宿主 `context.notifications.show({title,body})` |
| `schedules: true` | 宿主持久间隔任务，需要宿主入口与已声明命令 |
| `selectedResource: "read"` | 读取用户选择并明确分配的文件资源 |
| `selectedContent: true` | API 3；用户点击插件操作时获取当前草稿或该条消息文本，不订阅输入或读取对话历史 |
| `localResources: true` | 用户通过系统窗口选择文件或目录，视图读取文本、二进制或受控 URL |
| `fileEditing: true` | 在交互视图中打开用户明确选择的文件，按版本保存原件及恢复草稿（API 4） |
| `resourceExport: true` | 用户通过系统另存为窗口确认目标后，保存插件提供的字节 |
| `network: ["https://example.com"]` | 通过宿主向列出的 HTTPS origin 发 GET 请求、下载文件或打开外链 |

未声明权限默认为关闭，清单只需列出实际申请的权限，SDK 打包时会省略默认值。宿主忽略清单顶层、`permissions` 和 `contributes` 中不认识的声明，不因此提供对应能力；已知字段仍按类型和权限校验。需要新版能力时，通过 `engines.lexora` 和 API 版本声明兼容范围。视图无法访问 Node、宿主 DOM、全局键盘、网络 fetch 或任意本地文件。资源和网络调用通过 API；用户在安装确认中查看权限。系统剪贴板使用独立的读写权限，仅面向当前前台可见且聚焦的交互视图，详见 [视图与剪贴板](views.md#视图类型)。不提供任意系统消息、屏幕截图或跨插件事件订阅。
