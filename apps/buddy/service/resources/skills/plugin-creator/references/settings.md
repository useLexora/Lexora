# 声明式设置

## 设置

`contributes.settings` 包含三个可选数组：

- `modules: [{id,title,order?}]`：设置侧栏中的独立模块。
- `groups: [{id,module,title,order?}]`：模块中的分组。module 引用自己的模块或能力目录列出的内置模块。
- `items: [{id,key,group,title,description?,type,default,order?,enabledWhen?}]`：分组中的单项。group 引用自己的分组或能力目录开放的内置分组。

所有 id 以插件 ID 加 `.` 开头且全包唯一；key 在本插件内唯一，使用以小写字母开头的字母数字名称。order 范围 -1000–1000，默认 0。插件不能覆写宿主设置或插入其他插件的设置。

type 支持 boolean、string（最长 8192 字符）、number（可声明 min/max）、select（声明 `options:[{label,value}]`）、model。默认值必须符合类型；model 值为 `{providerId,modelId}` 或 null。模型选择规则见 [模型与任务权限](agent.md#模型与任务权限)，指定模型不可用时会失败，不会静默改用其他模型。

宿主自动保存设置，插件用 `context.configuration.get()` 读取，使用 `configuration.onChange` 注册可等待的热应用处理器；`context.events.on('configuration:changed', listener)` 仅观察已经保存的配置；订阅与失败回退见 [作用域事件](events.md)。修改设置取消当前插件调用，Agent 贡献变化从下一轮生效；关闭功能后旧工具也被拒绝。配置与 storage 私有业务数据独立，不维护第二份持久设置真源。已发布 key 保持类型和含义稳定，新增 key 使用 default。升级后不符合新选项或范围的旧值会被保留并在设置中标记，用户可以逐项修改或恢复默认值；修复前 Agent 贡献不可用。禁用和普通卸载保留配置；用户选择“卸载并清理”时删除配置、私有数据和视图状态。

设置项的 `enabledWhen: {condition,params?}` 引用插件注册的[条件函数](conditions.md)。关闭条件仅禁用输入并保留原值；控制开关自身保持可编辑。
