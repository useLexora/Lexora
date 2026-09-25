# 按需求选择插件能力

先决定数据从哪里来、用户在哪里操作、关闭页面后是否继续运行、哪些状态需要恢复。按下表选择能力，再查 [协议](protocol.md) 的清单字段和 [API 类型](api.d.ts) 的准确签名。能力可组合，但不必全部使用。

| 用户需要 | 清单与入口 | 状态和边界 |
| --- | --- | --- |
| 对当前文件提供阅读、统计或专用展示 | `selectedResource: "read"`；`resource: "selected-file"` 的视图；宿主可见命令将收到的 `resource` 传给 `views.open`，视图用 `resources.readText(context.resource)` 读取 | 用户先打开文件，再执行插件命令。句柄不包含任意路径，每次打开是独立实例；不能枚举目录、读其他视图的文件或写回文件 |
| 执行一次动作，无需常驻页面 | 宿主 `activate` 注册 `contributes.commands` 中的命令 | 可见命令进入命令面板和已安装插件卡片的“运行命令”菜单；命令收到的 `resource` 可能为空。只供自己视图调用的命令设为 `hidden: true` |
| 目录入口、较完整的页面或设置表单 | `contributes.navigation` 引用 `resource: "none"` 的视图 | API 2 可省略视图 `location`；页面由 `render` 绘制。需要持久配置时通过自身隐藏命令调用宿主私有存储 |
| 将自定义内容挂到页面区域 | `kind: "view"`、`target` 与 `presentation`；宿主命令调用 `placements.show/hide` | 区域包括 `workbench`、`app.sidebar`、`workbench.sidebar`。插件渲染隔离内容，通过通用外框布局接口声明定位和尺寸。挂载口没有面板 UI 或交互 |
| 限定生效页面或响应页面变化 | 贡献的 `when`；视图的 `workbench/onWorkbenchChange` 与 `visible/onVisibilityChange` | 按稳定页面 ID 与公开上下文匹配；离开范围隐藏而保留实例，业务暂停或继续由插件决定。未知上下文不匹配，不读取父页面 DOM |
| 自定义浮动内容或运行时换区域 | `presentation.position: "absolute"`；`setPresentation` 更新目标及外框 CSS 布局；`mount/onMountChange` 获取局部几何 | 拖动、折叠、恢复入口等由插件自行实现。宿主不理解这些行为，只维持独立实例、投影和边界；换位置保留会话，关闭销毁 |
| 用户选择的文件或目录 | `localResources: true`；交互视图的 `resources.pickFiles/pickDirectory` | 返回不透明句柄；任意文件格式都可读取。以 `scanDirectory` 按需筛选授权目录，`readText/readBytes/getUrl` 分别用于文本、分段二进制和受控 URL；只保存 ID，URL 按视图重新获取 |
| 将编辑结果或生成内容保存到本机 | `resourceExport: true`；交互视图调用 `resources.saveFile({name,data})` | 每次弹出系统另存为窗口，用户决定目标；取消返回 false。文本先编码为 Blob 或字节。读取授权不授予原文件覆写权限；保存成功后才报告完成 |
| 局部装饰、输入位置附近的短暂动画 | `windowEffects: true`；`kind: "decoration"` 与正式 `anchor` | 使用 `anchor/onAnchorChange` 的局部尺寸；输入活动经 `onActivity` 提供，可带局部 caret。不获取字符或全局键盘，不接收指针或焦点 |
| 在输入所在的整个分屏内绘制装饰 | `windowEffects: true`；`kind: "decoration"`、`anchor: "workbench.pane"` | 每个分屏独立实例，画布覆盖该分屏；只接收该分屏内的对话输入活动，caret 相对分屏。绘制位置由插件决定，不受输入框边界限制；不接收指针或焦点 |
| 整个 Lexora 窗口上的透明效果 | `windowEffects: true`；`resource: "none"`、`location: "window-overlay"` | API 1 和 API 2 均可用，每插件一个全窗口实例；收到无坐标的对话输入活动，不区分分屏。插件按窗口尺寸绘制，不接收指针或焦点 |
| 改变宿主控件的操作方式 | `controls: ["model.reasoning"]`；`kind: "control"`、`target: "model.reasoning"` | 安装后由用户选择样式。读取 `control.snapshot/onChange`，以当前快照 revision 提交 `propose`；值和允许选项归宿主管理，不能自建一份业务真源 |
| 读取远端公开信息 | 声明实际需要的 HTTPS origins，以宿主或视图的 `network.get` 获取 | 只有 GET，不携带浏览器登录态；直接 fetch、远程图片或媒体不替代网络代理。需要其他方法、凭据或实时连接时先说明能力缺口 |
| 关闭页面后仍定期执行插件动作 | `schedules: true`、宿主入口与已声明命令；`schedules.get/set/remove` | 定时任务归应用，最短一分钟；应用退出时暂停，错过的不补发。页面计时器只适合页面自身交互，不承担后台任务 |
| 系统提示 | `notifications: true`；宿主 `notifications.show` | 通知受用户全局开关和限速约束，返回 false 不表示插件崩溃。按真实需要与命令、调度组合 |

## 状态与模块

- `activate(context)` 管理命令、私有设置、通知和定时任务；`render(context, container)` 管理自己的隔离 UI。只需要视图时不创建空宿主；需要命令时必须同时声明宿主入口和命令 ID。
- 资源页签及普通挂载面板用 `ViewContext.state/setState` 保存该实例的筛选、阅读位置等 JSON。升级比较 `stateVersion` 与 `expectedStateVersion`，转换后再保存。导航页面、装饰和替换控件不支持这条持久化路径。
- 挂载目标和外框布局通过 `setPresentation` 更新；内容样式、交互及业务状态完全由插件实现，业务状态使用 `setState` 或宿主私有存储。宿主不会依据插件数量提供面板切换或自动避让。不能用父页面 CSS 选择器或 Vue Teleport 穿透隔离。
- 扩展级配置用宿主 `storage.get/set`。视图通过自身命令读写，不访问宿主内存；更改数据结构时增加 `dataVersion` 并提供 `migrate`。不要把一个文件的阅读位置存成覆盖所有文件的全局值。
- 每个视图具有独立 JS 环境。没有通用跨视图广播；需要设置同步时设计明确刷新入口或有界的读取周期，并在销毁时取消，不能承诺不存在的订阅事件。源码中的纯函数可通过包内相对导入复用。
- 视图通过 `signal` 清理监听、定时器、音频和异步回写；销毁时不要再异步保存状态，正常交互中及时保存，并处理保存失败；宿主通过 `subscriptions` 释放注册。恢复视图不代表自动播放音频或重放上次用户提交。

## 组合验收

验收从用户行为出发，不以采用某个样例的文件名或界面作为成功依据。例如文件阅读工具应验证两份不同文件、空内容、各自筛选状态及重开恢复；网络信息条应验证允许来源、请求失败后的状态、关闭与再次显示；自定义控件应验证当前快照、禁用或隐藏时提交被拒绝，以及故障后内置控件可用。

对每项需求明确已有 API 是否覆盖。没有任意插槽、父页面 DOM、静默覆写用户文件、通用 IPC 或 Agent 调用权限；核心要求超出已开放能力时先明确缺口与可实现范围，不能把样例资源或相近布局当作已经满足核心要求，也不用内部接口模拟完整实现。
