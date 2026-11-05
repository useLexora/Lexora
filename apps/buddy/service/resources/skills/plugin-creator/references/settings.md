# 声明式设置

## 设置页标题动作

API 3 自定义设置视图可以用 `context.setSettingsHeaderActions(actions)` 替换宿主标题右侧的动作，`[]` 清空。仅对通过本插件 `settings.modules[].view` 挂载的当前设置实例有效；同一 view 作为普通导航页打开时不具备此能力。无需额外权限，不修改清单 API 版本。

每次最多 4 项：`{id,title,icon?,disabled?,progress?}`。id 为 1–64 个字母、数字、点、下划线或连字符，以字母或数字开头，列表内唯一；title 去除首尾空白后为 1–40 字符且不可包含控制字符；icon 仅接受 `settings | download | refresh | add | back | more`。文本由宿主按纯文字显示，不能传 HTML、CSS、图片 URL 或宿主命令。顺序由数组决定；缺省可点击。

`progress` 省略时显示普通图标；`null` 显示不定圆环，不推测百分比；有限数值 `0..100` 显示圆环和向下取整的可读百分比，并提供无障碍进度值。进度替代图标，不改变点击或 disabled；标题仍由插件提供，例如 `下载历史 3`，不另设 badge。旧宿主可能拒绝该增量字段，应提示升级，不读父 DOM。

先用 `context.onSettingsHeaderAction(id => ...)` 订阅点击，再提交动作。也可订阅同一作用域的 `view:settings-header-action:activated` 事件（`data.id`）；二选一，避免重复处理。点击仅到原 view，不广播给同插件其他实例。

```ts
const subscription = context.onSettingsHeaderAction((id) => {
  if (id === 'engines' || id === 'downloads')
    navigate(id)
})
context.signal.addEventListener('abort', () => subscription.dispose(), { once: true })
await context.setSettingsHeaderActions([
  { id: 'engines', title: '推理引擎', icon: 'settings' },
  ...(taskCount > 0 ? [{ id: 'downloads', title: `下载任务 ${taskCount}`, icon: 'download' as const }] : []),
])
```

`navigate` 和 `taskCount` 由视图自身管理，任务数量变化时重新提交整组。动作只属于当前会话，不写入用户配置；离页、卸载、停用、更新或视图销毁自动撤回。返回设置页时在新 render 中读取业务快照并重新提交。`setSettingsHeaderActions` 与 `onSettingsHeaderAction` 是增量能力：先检查二者是否为函数，不支持时提示升级，不能读取父 DOM 或用定位伪造宿主标题动作。

## 设置

`contributes.settings` 包含三个可选数组：

- `modules: [{id,title,order?,section?,view?,experimental?}]`：设置侧栏中的独立模块。`section` 默认为 `plugins`，也可放入 `integrations`。`view` 可引用本插件 `location: page`、`resource: none` 的隔离视图，填满右侧内容区；此时模块不能再包含声明式分组。`experimental: { platforms: ['darwin'] }` 仅在匹配系统的侧栏入口显示轻量「实验性」标签，不附带说明，不改变权限或执行能力；省略则无标签。`platforms` 为 `darwin`、`linux`、`win32` 中非空且不重复的列表。
- `groups: [{id,module,title,order?}]`：模块中的分组。module 引用自己的模块或能力目录列出的内置模块。
- `items: [{id,key,group,title,description?,type,default,order?,enabledWhen?}]`：分组中的单项。group 引用自己的分组或能力目录开放的内置分组。

所有 id 以插件 ID 加 `.` 开头且全包唯一；key 在本插件内唯一，使用以小写字母开头的字母数字名称。order 范围 -1000–1000，默认 0。插件不能覆写宿主设置或插入其他插件的设置。

type 支持 boolean、string（最长 8192 字符）、number（可声明 min/max）、select（声明 `options:[{label,value}]`）、model。默认值必须符合类型；model 值为 `{providerId,modelId}` 或 null。模型选择规则见 [模型与任务权限](agent.md#模型与任务权限)，指定模型不可用时会失败，不会静默改用其他模型。

宿主自动保存设置，插件用 `context.configuration.get()` 读取，使用 `configuration.onChange` 注册可等待的热应用处理器；`context.events.on('configuration:changed', listener)` 仅观察已经保存的配置；订阅与失败回退见 [作用域事件](events.md)。修改设置取消当前插件调用，Agent 贡献变化从下一轮生效；关闭功能后旧工具也被拒绝。配置与 storage 私有业务数据独立，不维护第二份持久设置真源。已发布 key 保持类型和含义稳定，新增 key 使用 default。升级后不符合新选项或范围的旧值会被保留并在设置中标记，用户可以逐项修改或恢复默认值；修复前 Agent 贡献不可用。禁用和普通卸载保留配置；用户选择“卸载并清理”时删除配置、私有数据和视图状态。

设置项的 `enabledWhen: {condition,params?}` 引用插件注册的[条件函数](conditions.md)。关闭条件仅禁用输入并保留原值；控制开关自身保持可编辑。
