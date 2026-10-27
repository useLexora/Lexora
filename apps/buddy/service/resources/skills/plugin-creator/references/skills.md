# 插件 Skills

API 4 的 `contributes.skills` 将标准 Skill 随插件分发，可与工具、命令或视图组合。纯 Skills 包不需要 `entry`、`contributes.agent` 或额外权限。通过 `engines.lexora` 限定实际支持此能力的宿主版本。

## 声明与文件

在已有清单中加入：

```json
{
  "apiVersion": 4,
  "contributes": {
    "skills": [
      { "id": "<plugin-id>.xlsx", "path": "skills/xlsx/SKILL.md" }
    ]
  }
}
```

将 `<plugin-id>` 替换为该插件已有的 ID。贡献 ID 必须以插件 ID 加 `.` 开头且全包唯一。最多声明 32 个 Skill；各 Skill 使用独立目录，目录不能相互包含，也不能包含插件宿主或视图的入口文件。

```text
extension.json
skills/
  xlsx/
    SKILL.md
    references/
      workbook-format.md
    scripts/
      inspect-workbook.py
    assets/
      template.xlsx
```

`skills/xlsx/SKILL.md` 使用 YAML frontmatter，随后是非空正文：

```md
---
name: xlsx
description: 检查和编辑工作簿，在修改单元格、公式或工作表后验证保存结果。
---

先确认目标工作簿和修改范围，再使用当前可用的表格工具读取内容。
按需阅读 [工作簿格式说明](references/workbook-format.md)。
修改后保存并重新打开，核对目标单元格和公式结果。
```

`name` 使用小写字母、数字与单个连字符，最多 64 字符，必须与所在目录名相同，同一插件内不能重名。`description` 必填，最多 1024 字符，用于发现与选择；不要把完整操作流程写入描述。可用 `disable-model-invocation: true` 限制为手动选择。

构建会保留声明目录内的 `SKILL.md`、`references/`、`scripts/`、`assets/` 及其他文件的原始字节和相对路径；其中的脚本不会作为插件入口编译或执行。资源仍遵守安装包预算与安全路径规则，不使用符号链接或越界引用。

## 发现、调用与管理

宿主用插件 ID 最后一段作为命名空间。例如插件调用名为 `genoffice-xlsx`、frontmatter 为 `name: xlsx`，在输入框输入 `$genoffice-xlsx:xlsx` 并选择候选。不要把命名空间写入 frontmatter。相同调用名存在多个来源时，按插件归属选择具体候选。

技能进入已有 Skills 目录与搜索候选；模型根据名称和描述按需读取正文，用户也可显式选择。正文不会自动加入 `agent.instructions`，安装时不会把全部 Skill 正文注入对话。

技能由所属插件统一启用、停用、更新和卸载，不另建独立安装副本。停用后不再提供可用技能；更新或移除来源后，旧选择会失效，需要重新选择。已经进入对话的正文和独立授予的普通文件访问权限不会因此撤回。

Skill 提供工作方法和资源，不自动注册工具、启动 MCP 服务或授予文件、网络、命令执行权限。需要插件工具时另按 [Agent 工具与动作](agent.md) 声明；脚本只有通过宿主已有的工具和授权流程才可执行。

验收至少覆盖：安装后可搜索和显式选择、相对资源可读取、停用后不可重新选择、更新后旧选择失效，以及卸载不影响用户独立安装的 Skills。
