# 本机命令解释器

此能力要求 `apiVersion: 4`、`engines.lexora: ">=0.14.0 <1.0.0"` 和独立的 `permissions.shells: true`。API 1–3 插件仍可使用原有能力；只增加版本范围不能让旧 API 3 宿主识别这项能力。

插件声明候选和设置映射，Lexora 检测并执行；插件不获得进程、任意命令或配置写权限。只支持本机已有解释器的非交互命令，不安装解释器，不使用 WSL、PTY 或交互终端。

## 声明

`contributes.shells.candidates` 是最多 7 项的数组：

```json
{
  "id": "bash",
  "enabled": "bashEnabled",
  "executable": "bashExecutable",
  "priority": "bashPriority"
}
```

- id 固定为 `bash`、`git-bash`、`zsh`、`sh`、`powershell7`、`powershell51`、`cmd`，不得重复。Git Bash 使用 bash 方言。
- 其余三个字段引用本插件原生 settings 的不同 key。enabled 必须为默认 false 的 boolean；executable 必须为默认空字符串的 string；priority 必须为 number，default 0、min 0、max 100。不能在清单中放置可执行文件默认路径。
- 空路径表示自动检测；自定义绝对本机路径由用户在原生设置中通过系统文件选择器指定。表格中的路径只读，用户可主动重新检测、选择文件或恢复自动，无需手填。插件 configuration 仅可读取，不可用 storage 或命令参数替代。
- 只有用户启用的候选可供模型选择。priority 0 不参与优先选择；正数越小越优先，同数按声明顺序。全部为 0 时保留平台默认。
- 候选不适用于当前系统、缺失或检测失败时保留不可用结果与原因，不自动安装或切换解释器。

模型通过统一 `lexora_shell` 工具选择 `<extensionId>/<candidateId>`；`system` 表示原有平台解释器。未设置正优先级时默认仍为 system。检测成功不代表所有平台均能受控执行：当前插件候选执行接入 Linux/Windows，macOS 尚不开放。宿主 sh/zsh/CMD 命令会保守请求审批；CMD 只接受单行，Zsh 仍可能读取系统 zshenv。

## 原生设置表格

可选的 `contributes.shells.settingsGroup` 引用本插件声明的设置组 ID；所有候选引用的 enabled、executable、priority 设置必须属于这个组。宿主将该组渲染为原生表格，每个候选一行，包含启用、检测状态、版本、只读路径、优先级和路径操作，无需插件自定义视图或命令。

建议将该组注册到内置 `settings.runtime` 模块：

```json
{
  "shells": {
    "settingsGroup": "<plugin-id>.execution",
    "candidates": [{ "id": "bash", "enabled": "bashEnabled", "executable": "bashExecutable", "priority": "bashPriority" }]
  },
  "settings": {
    "modules": [],
    "groups": [{ "id": "<plugin-id>.execution", "module": "settings.runtime", "title": "命令解释器" }],
    "items": [
      { "id": "<plugin-id>.bash.enabled", "key": "bashEnabled", "group": "<plugin-id>.execution", "title": "启用", "type": "boolean", "default": false },
      { "id": "<plugin-id>.bash.executable", "key": "bashExecutable", "group": "<plugin-id>.execution", "title": "路径", "type": "string", "default": "" },
      { "id": "<plugin-id>.bash.priority", "key": "bashPriority", "group": "<plugin-id>.execution", "title": "优先级", "type": "number", "default": 0, "min": 0, "max": 100 }
    ]
  }
}
```

上述对象是 `contributes` 的内容，`<plugin-id>` 替换为清单中的插件 ID。无需自定义交互时可只保留清单和资源，不声明 entry、commands 或 views。

文件选择仅开放给可信的原生设置窗口，不属于插件 SDK。选择前验证启用、权限和候选声明；返回前复验包版本与有效性。选择本身不执行程序、不创建文件资源授权、不写入配置；取消返回空结果。原生设置通过既有配置保存链保存所选路径或空字符串（恢复自动），保留原设置 key 和用户值。

## 检测

插件 SDK 仅宿主入口提供 `await context.shells.detect()`，无任何参数；原生设置也可主动刷新检测。它返回声明候选的 `{id,label,dialect,executable,version,available,reason?}[]`，包含未启用和不可用项。版本和路径由宿主检测，插件不能传命令、路径或探针参数。检测是有界的，相同配置并发合并；一秒内刷新复用结果。

SDK 的 Shell 能力仍只有只读 `shells.detect()`，配置仅有 `configuration.get()` 与 `configuration.onChange()`，不提供文件选择或配置写入。特殊自定义视图可经本插件隐藏命令读取检测结果，不直接访问 Shell；使用原生表格时无需重复提供检测视图。缺失时明确提示，不附安装操作或指引。不要申请 agent、network、localResources 或 inference 权限来绕开此边界。

配置变更影响下一轮任务；禁用、卸载和应用插件更新撤回旧贡献，正在运行的命令不更换解释器。解释器可用不表示获得文件或网络授权，执行仍由核心沿原审批、目录、网络、超时和取消机制处理。
