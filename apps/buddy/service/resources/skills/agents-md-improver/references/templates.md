# AGENTS.md / CLAUDE.md & README.md Templates

## Key Principles（核心原则）

- **Concise（精炼）**: Dense, human-readable content; one line per concept when possible（高密度、易读，尽量一行说清一条规则）
- **Lightweight Index（轻量索引）**: Keep root `README.md` (human overview/status/index) and `AGENTS.md` / `CLAUDE.md` (agent rules/gotchas/routes) lean; link to sub-files for long details（根目录文件只做轻量目录与状态看板，长内容下沉到子文件并挂链接）
- **Actionable（可执行）**: Commands and file routes should be concrete and ready to use（命令与文件路径必须真实具体）
- **Project-specific（贴合当前项目）**: Document patterns unique to this workspace, not generic advice（只记当前项目/工作区特有的约定，不写通用套话）
- **Current（保持最新）**: All info should reflect actual files and current status（所有路径与状态必须反映当前真实情况）

---

## Recommended Sections（推荐章节积木，按需选用）

Use only the sections relevant to the workspace. Not all sections are needed.

### Commands（常用命令 — 适用于代码工程）

Document the essential commands for working with the project.

```markdown
## Commands

| Command | Description |
|---------|-------------|
| `<install command>` | Install dependencies |
| `<dev command>` | Start development server |
| `<build command>` | Production build |
| `<test command>` | Run tests |
| `<lint command>` | Lint/format code |
```

### Architecture / Structure（目录结构地图）

Describe the workspace structure so both humans and the agent understand where things live.

````markdown
## Structure

```text
<root>/
  <dir>/    # <文件夹用途说明>
  <dir>/    # <文件夹用途说明>
```
````

### Key Files & Routing（关键文件与按需读取路由）

List important files, what they cover, and when to read them.

```markdown
## Key Files

- `<path>` - <文件用途 / 什么情况下读取>
- `<path>` - <文件用途 / 什么情况下读取>
```

### Code / Writing Style（代码或行文规范）

Document workspace-specific conventions or terminology.

```markdown
## Style & Conventions

- <命名、术语简称或格式约定>
- <偏好做法 vs 避免做法>
```

### Environment（环境与依赖配置）

Document required environment variables and setup.

```markdown
## Environment

Required:
- `<VAR_NAME>` - <purpose>

Setup:
- <setup step>
```

### Testing（测试约定）

Document testing approach and commands.

```markdown
## Testing

- `<test command>` - <what it tests>
- <testing convention or pattern>
```

### Gotchas（避坑指南与红线禁忌）

Document non-obvious patterns, factual red lines, quirks, and warnings.

```markdown
## Gotchas

- <容易踩坑的非直观限制或不可违背的事实口径>
- <先后顺序依赖或前置条件>
- <明确禁止的操作>
```

### Workflow（工作流约定）

Document workflow patterns.

```markdown
## Workflow

- <遇到场景 X 时的标准处理步骤>
- <处理任务 Y 的优先方式>
```

---

## Template: Workspace Root (Minimal / 极简通用模板)

````markdown
# <Project / Workspace Name>

<一句话简介（详细背景与进度见 README.md）>

## Key Files & Routing

- `README.md` - 项目/事项概览、最新进展与完整子文档索引
- `<path>` - <用途与触发读取条件>

## Structure

```text
<structure>
```

## Gotchas & Red Lines

- <核心红线或避坑事项>
````

---

## Template: Project Root (Comprehensive / 完整工程模板)

````markdown
# <Project Name>

<One-line description>

## Commands

| Command | Description |
|---------|-------------|
| `<command>` | <description> |

## Structure

```text
<structure with descriptions>
```

## Key Files

- `<path>` - <purpose / when to read>

## Style & Conventions

- <convention>

## Environment

- `<VAR>` - <purpose>

## Testing

- `<command>` - <scope>

## Gotchas

- <gotcha>
````

---

## Template: Package/Module（子模块模板）

For packages within a monorepo or distinct modules.

````markdown
# <Package Name>

<Purpose of this package>

## Usage

```text
<import/usage example>
```

## Key Exports

- `<export>` - <purpose>

## Dependencies

- `<dependency>` - <why needed>

## Notes

- <important note>
````

---

## Template: Monorepo Root（多包仓库模板）

```markdown
# <Monorepo Name>

<Description>

## Packages

| Package | Description | Path |
|---------|-------------|------|
| `<name>` | <purpose> | `<path>` |

## Commands

| Command | Description |
|---------|-------------|
| `<command>` | <description> |

## Cross-Package Patterns

- <shared pattern>
- <generation/sync pattern>
```

---

## Update Principles（更新原则）

When updating any `AGENTS.md` / `CLAUDE.md` or `README.md`:

1. **Be specific**: Use actual file paths and real commands/facts from this workspace
2. **Be current**: Verify info against actual files; replace obsolete status in place
3. **Be brief**: One line per concept when possible; keep root files as lightweight indexes
4. **Be useful**: Would this help a new session immediately understand the workspace?
