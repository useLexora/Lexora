# Spec-005：新增"新任务默认权限"设置

**日期：** 2026-09-28

**状态：** 已实现；自动化测试覆盖核心配置与草稿逻辑，待手动验收

**目标：** 在设置页新增一项"新任务默认权限"，让用户把新任务的默认审批模式从"智能审批"改成自己偏好的模式（例如"完全访问"）。该设置只影响此后新建的任务，不追溯已有会话。

---

## 1. 背景与问题定位

### 1.1 现状

每个任务的权限模式由"草稿"（composer draft）携带，底层字段是两个：

- `approvalPolicy`（审批策略）：`manual` / `policy`
- `executionProfile`（执行档位）：`read_only` / `workspace_write` / `full_access`

界面上看到的 4 个模式，是由这两个字段反推出来的（`resolveBuddyPermissionMode()`）：

| 界面名称 | `approvalPolicy` | `executionProfile` |
|---|---|---|
| 只读 | `policy` | `read_only` |
| 人工审批 | `manual` | `workspace_write` |
| 智能审批 | `policy` | `workspace_write` |
| 完全访问 | `policy` | `full_access` |

相关代码：

- `apps/buddy/shared/permissions/permissionMode.ts`：模式定义与双向转换。
- `apps/buddy/src/modules/tasks/state/drafts/useChatDrafts.ts`：`emptyDraft()` 决定新草稿的初值。
- `apps/buddy/src/modules/prompt-input/components/DesktopPermissionModeSelector.vue`：输入框里的权限弹窗，当前唯一的修改入口。

### 1.2 问题

新草稿的初值是**硬编码**的：

- `BUDDY_DEFAULT_APPROVAL_POLICY = 'policy'`
- `BUDDY_DEFAULT_EXECUTION_PROFILE = 'workspace_write'`

两者组合即"智能审批"。用户可以在输入框的权限弹窗里逐个任务改成"完全访问"，但**没有任何全局默认值**。不认同"智能审批"的用户，每新建一个任务都要手动改一次。

### 1.3 本功能要解决的事

提供一个全局默认值，让用户在设置页改一次，之后新建的任务自动使用该模式。

## 2. 已确认的决定

### 决定 1：出厂默认保持"智能审批"

`config.toml` 中该设置的默认值定为 `policy_approval`，不是 `full_access`。

理由：如果出厂默认改成"完全访问"，所有**已经安装** Lexora 的用户在升级后会静默变成完全访问 —— 用户没有点过任何按钮，权限就被放开了。需要完全访问的用户自己在设置里改一次即可。

### 决定 2：设置变化不追溯已有任务

修改设置后，**只有此后新建的任务**使用新默认值；已经打开或已经存在的任务保持原模式不变。

原因见 4.2 节（草稿在打开时就已经落库）。当前那个"还没开始用的空任务"不会跟着变，设置行下方需要一句说明文案。

## 3. 需求边界

**包含：**

- 设置页新增一项"新任务默认权限"，可选 4 个模式（只读 / 人工审批 / 智能审批 / 完全访问）。
- 该值持久化到 `~/.lexora/config.toml`。
- 新建任务的草稿初值使用该设置。
- 选择"完全访问"作为默认值时，弹出确认对话框（复用现有组件）。

**不包含：**

- 不改变已有会话、已有草稿、正在运行任务的权限。
- 不改变输入框权限弹窗的逐个任务覆盖行为（它仍然是每个任务的临时开关）。
- **不作用到后台定时任务。** 定时任务有自己的 `executionProfile`（`service/src/automations/createAutomationTool.ts`，默认 `workspace_write`）。"无人值守 + 完全访问"风险更高，应由独立开关控制，不跟随本设置。
- 不新增权限模式，不修改权限判定与越级限制逻辑。

## 4. 设计方案

### 4.1 数据模型：存"模式"，不存两个底层字段

配置项存 `BuddyPermissionMode`（即 4 个模式之一），而不是分别存 `approvalPolicy` 和 `executionProfile`。

理由：

- "模式"才是用户看得见的概念；
- 分别存两个字段会产生 UI 里根本不存在的组合（例如 `manual` + `read_only`）；
- 已有 `resolveBuddyPermissionSettings(mode)` 可以直接把模式展开成两个底层字段，不需要新增转换逻辑。

配置落点：`desktop.chat.permissionMode`，与 `desktop.chat.welcome`、`desktop.chat.outlinePosition` 同级。在 TOML 文件里写作 `permission_mode`。

同时在 `apps/buddy/shared/permissions/permissionMode.ts` 新增常量：

```ts
export const BUDDY_DEFAULT_PERMISSION_MODE: BuddyPermissionMode = 'policy_approval'
```

由它作为出厂默认的唯一定义处，现有两个 `BUDDY_DEFAULT_*` 常量继续作为配置加载完成前的兜底值。

### 4.2 生效路径

新草稿的初值只在一个地方产生：`useChatDrafts()` 里的 `emptyDraft()`。方案是在这里注入配置值：

1. `useChatDrafts()` 增加入参 `defaultPermissionSettings`，`emptyDraft()` 用它填初值。
2. `apps/buddy/src/modules/tasks/state/useTaskCapability.ts` 从 `applicationSettings.config` 计算该值：
   `resolveBuddyPermissionSettings(config?.desktop.chat.permissionMode ?? BUDDY_DEFAULT_PERMISSION_MODE)`
3. 往下全部复用现有链路：草稿落库时写入 `initialExecutionConfig`，发送消息时会话继承草稿的权限设置。
4. 本地服务侧不需要改动。`isExecutionProfileWithin()` 的越级限制照旧生效。

#### 为什么"不追溯已有任务"是自然结果

按现在的实现，草稿在任务工作区挂载时就会被写入数据库（`useTaskWorkspacePersistence.restoreWorkspace()` → `ensureDraft()` → `composerDrafts.open()`）。

因此会出现这个现象：

1. 用户打开软件，进入任务页 → 当前空任务的权限被存成"智能审批"；
2. 用户去设置页改成"完全访问"；
3. 用户回到刚才那个任务 → 仍然是"智能审批"（它的记录已经存在）；
4. 用户新建任务 → 才是"完全访问"。

配置尚未加载时创建的草稿也按此规则处理：先用 `BUDDY_DEFAULT_PERMISSION_MODE`（"智能审批"）创建；如果该草稿随后已落库，配置加载完成或用户修改设置后都不追溯刷新它。这里的"新建任务使用新默认值"指创建草稿时默认配置已经可用的任务；配置加载前创建的草稿属于已存在草稿。

这不是缺陷，而是"已落库的记录不被追溯修改"。本方案接受该行为（决定 2），但必须在设置页写清说明文案。

如果将来要改成"立刻跟随"，需要额外引入"该草稿是否被用户手动改过权限"的标记，只在"内容为空 + 未手动改过"时刷新。这属于后续可选方向，不在本次范围。

### 4.3 界面

最小方案：在"常规"设置页新增一行。

- 位置：`apps/buddy/src/modules/settings/widgets/app/DesktopGeneralSettings.vue`，复用现有的 `desktop-settings-row` 结构与样式。
- 控件：`NSelect`，4 个选项。
- 文案：**复用**输入框权限弹窗已有的标签和描述文案键，不新写一套，避免以后改文案要改两处。权限弹窗会根据沙盒状态切换 sandbox 描述；设置页不展示沙盒状态专属描述，只展示下列通用描述，因为此设置表达的是默认权限模式，而非当前任务的实际沙盒边界：
  - 标签：`desktop.chat.executionProfileReadOnly`、`desktop.chat.permissionModeManual`、`desktop.chat.permissionModePolicy`、`desktop.chat.executionProfileFull`
  - 描述：`desktop.chat.permissionModeReadOnlyDescription`、`desktop.chat.permissionModeManualDescription`、`desktop.chat.permissionModePolicyDescription`、`desktop.chat.permissionModeFullDescription`
- 行下方常驻说明文案（新增键）："只影响新建任务，已有会话保持原模式。"
- 选择"完全访问"时，先弹出 `apps/buddy/src/modules/prompt-input/components/DesktopFullAccessConfirmationDialog.vue`（现有组件，带勾选确认），确认后才写入设置。

若后续还要加入沙盒状态、审批规则、工具白名单等，再考虑独立开一个"权限"设置分类（新增路由 + i18n + 侧边栏项）。只加这一个开关时，常规页改动面更小。

### 4.4 预期改动范围

| 文件 | 计划调整 |
|---|---|
| `apps/buddy/shared/permissions/permissionMode.ts` | 新增 `BUDDY_DEFAULT_PERMISSION_MODE` 常量 |
| `apps/buddy/electron/shared/desktopApi.ts` | `DesktopChatPreferences` 与 `DEFAULT_DESKTOP_CHAT_PREFERENCES` 增加 `permissionMode` |
| `apps/buddy/electron/shared/desktopApiSchemas.ts` | `lexoraConfigPatchSchema.desktop.chat` 增加 `permissionMode`（该对象是 `.strict()`，不加会直接报错） |
| `apps/buddy/electron/main/config/LexoraConfigStore.ts` | `desktopConfigSchema.chat` 增加 `permission_mode`；`decodeConfig`、`encodeConfig` 的 chat 映射各加一行；schema 默认值块同步 |
| `apps/buddy/src/modules/tasks/state/drafts/useChatDrafts.ts` | `emptyDraft()` 接收注入的默认权限设置 |
| `apps/buddy/src/modules/tasks/state/useTaskCapability.ts` | 从配置计算默认权限设置并传入 |
| `apps/buddy/src/modules/settings/widgets/app/DesktopGeneralSettings.vue` | 新增设置行与完全访问确认 |
| `apps/buddy/src/i18n/locales/zh-CN/settings.ts`、`en-US/settings.ts` | 新增行标题与说明文案 |
| 相关类型与 schema 测试 | 验证配置类型、默认值、合法/非法值校验及读写映射 |
| `useChatDrafts`、设置组件及配置存储相关测试 | 覆盖默认注入、配置加载前回退、既有草稿不追溯、确认取消与保存失败等边界 |

**最容易漏的一处：** `desktopConfigSchema.chat` 使用了 `.passthrough()`。只往 TOML 里写 `permission_mode` 而不同步 `decodeConfig` / `encodeConfig` 的映射，值会被静默保留但读不出来 —— 表现为"设置改了但完全没生效，而且不报错"。

## 5. 验收标准

- [ ] 设置页出现"新任务默认权限"，可选 4 个模式，默认显示"智能审批"。
- [ ] 选择"完全访问"时先弹出确认对话框，取消则不写入。
- [ ] 设置值写入 `~/.lexora/config.toml` 的 `permission_mode`，重启应用后仍生效。
- [ ] 修改设置后，新建任务的权限弹窗显示新模式。
- [ ] 修改设置后，已有会话与已有草稿的权限模式保持不变。
- [ ] 设置页的说明文案明确写出"只影响新建任务"。
- [ ] 后台定时任务的 `executionProfile` 不受该设置影响。
- [ ] 配置更新入口拒绝非法 `permissionMode`，不产生半写入状态；配置文件加载时遇到非法 `permission_mode`，按配置 store 的既有 schema 校验策略处理，不得静默接受非法值，并应覆盖相应行为的测试。
- [ ] 配置加载完成前（`config` 为 `null`）新建的草稿回退到"智能审批"，不报错；该草稿之后不因配置加载完成而自动刷新权限。
- [ ] 完全访问确认对话框取消时不写入设置；确认后才提交更新。
- [ ] 设置保存失败时界面显示失败反馈，选择器恢复为配置中的实际值；保存进行中禁用重复提交。

## 6. 风险和取舍

- **完全访问的暴露面变大。** 之前它是"单个任务的临时选择"，现在会成为"每个新任务的起点"。因此保留确认对话框是必要的，且输入框的红色危险样式继续保留，让用户在每个新任务上都能看到当前是完全访问。
- **设置与当前任务不一致的观感。** 用户改完设置回到刚才的任务，模式没变（见 4.2）。这是决定 2 的已知代价，用说明文案缓解。
- **出厂默认不能跟着改。** 决定 1 会让"想要完全访问"的用户仍需手动改一次。这是为了保护已有用户不被静默放开权限，属于有意取舍。
- **本功能不提升权限上限。** 完全访问仍然受操作系统权限约束，不会获得管理员权限，部分敏感操作仍需确认。

## 7. 未决事项

- 是否在输入框权限弹窗底部增加"设为默认"入口（让用户不必跳到设置页）。当前未纳入本次范围。
- 是否需要在将来让"还没开始用的空任务"立刻跟随新默认值（4.2 末尾描述的可选方向）。

## 8. 实现记录

已实现本方案的配置持久化、设置页入口和新草稿默认值注入。配置仍以 `desktop.chat.permissionMode` 表示，并通过既有双向转换得到底层审批策略与执行档位；后台自动化不读取该设置。选择"完全访问"时复用现有确认对话框，保存失败时复用设置页错误提示，选择器由配置值控制。

自动化测试覆盖配置默认值、TOML 读写、非法值拒绝及新建草稿使用配置模式/既有草稿不追溯。验收清单暂不勾选：设置页完整交互、应用重启后生效及相关边界仍需手动验收；规范中未列出的组件级 UI 自动化测试也未补充。

---

**状态说明：** 实现已随本 PR 提交；验收清单保留为待验证项，合并前后可继续补充手动验收结果。
