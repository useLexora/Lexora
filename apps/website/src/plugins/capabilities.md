---
title: "Skills、MCP 与 NPC"
description: "独立声明插件 Skills、远端 MCP 连接与专业 NPC，并通过显式依赖组合能力。"
---

# Skills、MCP 与 NPC

三类贡献解决不同问题，可以分别交付，不要求捆绑。它们都使用 API 4，纯声明包不需要后台 `entry`、`contributes.agent` 或额外插件权限；实际使用仍受宿主配置与授权限制。通过 `engines.lexora` 约束已经验证的支持版本，API 4 本身不足以证明兼容。

| 目标 | 声明 | 不会自动发生什么 |
| --- | --- | --- |
| 提供工作方法与配套资源 | `contributes.skills` | 不注册工具、不执行脚本、不授予权限 |
| 提供远端工具服务定义 | `contributes.mcpConnectors` | 不自动连接、不携带用户凭据、不授予远端调用权 |
| 提供可委派的专业 NPC | `contributes.subagents` | 不成为主角、不自动招募或绑定伙伴、不继承全部工具 |

主模型可调用的插件工具与任务事件动作见[工具与任务动作](./agent)；模型后端见[模型与多模态能力](./inference)。以下片段并入自己的清单，不是完整安装包。

## Skills {#skills}

Skill 的 ID 使用完整插件贡献 ID，`path` 指向独立目录中的标准 `SKILL.md`：

```json
{
  "contributes": {
    "skills": [{
      "id": "example.research.research",
      "path": "skills/research/SKILL.md"
    }]
  }
}
```

此例假设插件 ID 为 `example.research`。目录可附带 `references/`、`scripts/` 和 `assets/`；构建保留字节和相对路径，不将其中脚本当作后台入口执行。各 Skill 目录不得相互包含，也不能包含后台或视图入口，最多 32 个 Skill。

```md
---
name: research
description: 核对用户指定材料，整理结论与可追溯来源。
---

先明确问题和材料范围，再使用当前可用工具收集证据。
区分来源事实与推断，无法验证的内容明确标注。
```

frontmatter 的 `name` 与目录名相同，使用小写字母、数字与单连字符，最多 64 字符，同包不重名；`description` 必填，最多 1024 字符。不要把命名空间写进 name。可用 `disable-model-invocation: true` 限制为手动选择。

安装启用后可在已有 Skills 搜索入口发现；调用名使用插件 ID 最后一段作为命名空间，如 `$research:research`。用户可显式选择，模型也可按描述读取；安装不会把全部正文自动注入对话。Skill 不自动注册工具、启动 MCP 或运行附带脚本，脚本仍需已有工具与用户授权。

插件管理 Skill 的启停、更新与卸载，不复制成用户独立安装。来源更新后旧选择失效，应重新选择；停用后不可重新发现为可用能力。已进入对话的正文和独立授予的文件权限不会因此被撤回。

## MCP {#mcp}

MCP 连接是独立的服务声明，ID 使用包内局部名称，不加插件 ID 前缀：

```json
{
  "contributes": {
    "mcpConnectors": [{
      "id": "search",
      "name": "材料检索",
      "transport": "streamable-http",
      "url": "https://search.example.com/mcp",
      "authentication": "bearer"
    }]
  }
}
```

替换为实际服务地址。最多 16 个连接；id 为 1–64 个小写字母、数字、`-` 或 `_`，首字符为字母或数字，同类贡献内唯一。只支持 HTTPS Streamable HTTP，URL 不含 userinfo；不支持通过 `stdio` 启动本机命令。

`authentication` 必须显式声明 `none`、`bearer` 或 `oauth`，仅表示认证需求；OAuth 登录还需核对目标宿主的实际支持。不声明任意 headers、credential 或秘密，不把 Token 填入 URL、包或日志。用户在宿主中配置凭据、启用状态和工具发现方式，安装不会自动连接。

连接定义随插件更新，用户认证与开关由宿主管理。目标或认证方式改变时不能把旧凭据带到新目标；远端工具是否可执行及其副作用仍由工具策略和授权决定，工具名称或提示词不能把写操作变成只读。

## NPC {#npc}

界面称为 NPC，清单键仍为 `subagents`。当前不支持插件注册主角，也不在清单声明 `kind` 或伙伴绑定：

```json
{
  "contributes": {
    "subagents": [{
      "id": "reader",
      "name": "材料阅读员",
      "instructions": "阅读用户指定材料，返回摘要与原文依据。",
      "tools": [{ "source": "builtin", "name": "read" }],
      "fileAccess": "read_only"
    }]
  }
}
```

最多 16 个 NPC。id 使用与 MCP 相同的局部格式，但属于独立种类，不可占用内置 NPC ID。必填 `name`、`instructions`、`fileAccess`；`skills`、`requiredSkills`、`tools` 默认空数组，不表示继承全部能力。

内置工具引用仅支持 `read`、`find`、`grep`、`ls`，不支持任意管理工具、命令执行或插件工具引用。`fileAccess: "inherit"` 继承当前任务的权限上限，不增加目录授权；`read_only` 限制文件访问为只读。任务或祖先的只读上限不能被 NPC 放宽。

安装只注册 NPC。用户在伙伴中招募它，并配置启用与模型；未指定模型时继承调用者实际模型。来源定义随插件更新，不能直接编辑；用户可复制为独立 NPC，但副本不会复制 MCP 凭据或 Skill 实体，也不会自动解除依赖。

## 显式组合依赖

只有引用才产生组合关系，同包交付、相同名称或安装顺序都不会自动绑定。可在上面的 NPC 中替换能力字段：

```json
{
  "skills": ["example.research.research"],
  "requiredSkills": ["example.research.research"],
  "tools": [{ "source": "mcp", "connector": "search", "name": "search_documents" }],
  "fileAccess": "inherit"
}
```

- `skills` 使用本包 Skill 的完整贡献 ID，不是 frontmatter 名或调用名。`requiredSkills` 必须是 `skills` 的子集；必需 Skill 不可用时 NPC 不就绪。
- MCP `connector` 使用本包连接局部 ID；`name` 是服务真实提供的原始工具名，不是宿主生成的调用名。示例服务必须实际提供 `search_documents`。
- 不能引用其他插件或用户连接。含 MCP 工具时必须使用 `inherit`，不能与 `read_only` 组合，因为远端副作用不能由声明保证。
- 空工具列表不是“所有工具”，也不因引入一个 Skill 获得其提到的工具。依赖失效时依赖者不可用，不扩大范围到其他连接。

## 生命周期与验收

停用、卸载或移除声明使相应来源不可用，也影响明确依赖它的 NPC。普通卸载保留用户配置，不把受管理连接或 NPC 转成用户自建记录；MCP 重装不会自动重新启用。清理配置与凭据需用户显式选择，不能默认删除独立副本、用户 Skills 或任务历史。

按实际交付能力验证：Skill 可搜索、选中并读取相对资源；MCP 可由用户认证、启停、发现并调用真实工具；NPC 可由用户招募、选择模型和委派，且遵守文件权限与依赖边界。最后检查更新后的旧选择、依赖缺失、停用、卸载和重新安装。清单解析通过不等于连接可用或 NPC 已就绪。

完整字段见 [API 参考](./api)，包与分发要求见[构建与分发](./distribution)。
