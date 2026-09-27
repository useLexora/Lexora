# 内容插槽与替换控件

宿主负责位置、布局、隔离与冲突处理，插件负责配置交互。插件管理页只管理安装、启停、更新、卸载和授权，不提供插件功能或插槽配置。通过 `lexora_plugin_capabilities({kind:"slot"})` 或 `{kind:"control"}` 查询目标、作用范围、单选或多选策略及高度限制；不要根据 CSS 类名推测目标。

内容插槽使用 API 3，声明 `{id,kind:"slot",target,view,height?,enabled?}`；替换控件使用 API 2 起的 `kind:"control"`，并声明目标的 controls 权限。`view` 引用本插件 `resource:"none"` 的视图。两者不接受 `presentation`。`enabled` 默认 true；可选功能可声明 false，由插件自己的设置启用。旧清单无需修改即可注册。

宿主入口通过 `context.placements.show(id)` / `hide(id)` 启用或撤回本插件的 slot/control，返回该贡献 ID，不接受 instanceId 或 interactionId。请求只在当前宿主运行期间生效；持久偏好由插件自己的 `storage` 保存，activate 中读取并重新应用。调用成功表示启用状态已应用，不保证当前页面、竞争和内容状态允许显示。配置可以放在插件已有页面、面板或菜单，不要求新增独立设置页。

视图通过 `await context.setActive(false)` 表示自己当前没有可展示内容，true 表示恢复。此状态仅属于当前视图，不修改插件设置，也不销毁 iframe。初次渲染可以先撤回，取得业务状态后再启用；宿主等待 render 完成才认为视图就绪。关闭、无内容或出错时由宿主渲染真正的默认内容，插件不要复制系统提示或样式。

同一单选目标按稳定顺序使用首个已启用、符合页面条件、就绪且 active 的视图；多选目标按该顺序最多显示八个。旧版本保存的选择只作为优先顺序保留，其余按贡献 ID 排序。不可用贡献让出位置。`context.visible/onVisibilityChange` 反馈实际显示结果；不要用 visible 反向决定 active，否则隐藏后无法恢复。隐藏视图继续接收本插件的广播，可据新内容调用 setActive(true)。持续失败不自动重试；替换控件可由插件显式关闭再开启，或重启插件后重试。

每个宿主位置拥有独立视图，`context.instanceId` 是所在分屏的不透明标识，可能为空；不提供任务身份、历史或输入文字。符合页面条件的视图会初始化，即使贡献尚未启用或被其他提供者占用，以便恢复插件配置和监听内容变化。隐藏时停止不必要的绘制与轮询，保留恢复所需的订阅。

内容插槽和替换控件不用 setState；共享业务数据通过自身宿主命令读写 storage，用 views.broadcast 通知自身视图。配置更新需验证即时生效、关闭后恢复默认内容、重新开启和应用重启恢复。视图销毁时清理订阅与资源。
