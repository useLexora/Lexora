---
title: "第一个插件"
description: "创建一个有命令入口、独立界面与实例状态的计数面板，并构建安装包。"
---

# 第一个插件

这个例子会创建一个计数面板：用命令打开，点击按钮增加数字，切换标签后保留当前实例的计数。你会接触清单、后台入口、视图和构建工具。

## 准备开发环境

安装 Lexora。获取 [Lexora 源码](https://github.com/useLexora/Lexora)，按照根 `package.json` 的 `engines` 和 `packageManager` 准备 Node.js 与 pnpm，再安装 workspace 依赖：

```sh
git clone https://github.com/useLexora/Lexora.git
cd Lexora
pnpm install
```

已有独立 Lexora Plugin SDK 时，也可使用其 check/package 命令；两种工具使用相同的包协议，见[构建与分发](./distribution)。

创建一个与 Lexora 仓库并列的 `counter` 目录，将仓库中的 `apps/buddy/service/resources/skills/plugin-creator/references/api.d.ts` 复制为 `counter/lexora.d.ts`。它只提供类型，不是运行时依赖。

```text
counter/
├── extension.json
├── main.ts
├── view.ts
└── lexora.d.ts
```

## 声明插件

创建 `extension.json`：

```json
{
  "schemaVersion": 1,
  "format": "source",
  "id": "example.counter",
  "name": "计数面板",
  "version": "1.0.0",
  "apiVersion": 4,
  "engines": { "lexora": ">=0.16.2" },
  "entry": "main.ts",
  "permissions": {},
  "contributes": {
    "commands": [{
      "id": "example.counter.open",
      "title": "打开计数面板",
      "slash": { "name": "open", "description": "打开计数面板" }
    }],
    "views": [{
      "id": "example.counter.panel",
      "title": "计数面板",
      "entry": "view.ts",
      "resource": "none"
    }]
  }
}
```

示例没有文件、网络或模型访问，因此不申请这些权限。`example.counter` 供本教程使用；创建独立作品时，在应用内生成插件身份或使用 SDK 的 `createExtensionId`，同步修改贡献 ID，此后持续保留身份。

## 注册打开命令

创建 `main.ts`：

```ts
import type { ExtensionContext } from './lexora'

export function activate(context: ExtensionContext) {
  context.subscriptions.add(
    context.commands.register(`${context.extension.id}.open`, async () => {
      await context.views.open(`${context.extension.id}.panel`)
    }),
  )
}
```

后台注册与清单中的命令一一对应。停用插件时，宿主释放加入 subscriptions 的注册。

## 绘制界面与保存状态

创建 `view.ts`：

```ts
import type { ViewContext } from './lexora'

export function render(context: ViewContext, container: HTMLElement) {
  const saved = context.state
  let count = typeof saved === 'object' && saved !== null
    && !Array.isArray(saved) && typeof saved.count === 'number'
    ? saved.count
    : 0
  const button = document.createElement('button')
  const status = document.createElement('p')
  button.textContent = `计数：${count}`
  status.setAttribute('role', 'status')
  container.style.padding = '24px'
  container.replaceChildren(button, status)

  button.addEventListener('click', async () => {
    button.disabled = true
    try {
      const next = count + 1
      await context.setState({ count: next })
      if (context.signal.aborted)
        return
      count = next
      button.textContent = `计数：${count}`
      status.textContent = ''
    }
    catch (error) {
      if (!context.signal.aborted)
        status.textContent = error instanceof Error ? error.message : String(error)
    }
    finally {
      if (!context.signal.aborted)
        button.disabled = false
    }
  }, { signal: context.signal })
}
```

状态属于当前标签实例。按钮等待保存完成再更新计数，失败时保留原值并显示错误；视图结束后不再更新界面。另开一个面板会得到独立实例。

## 构建并安装

回到 Lexora 仓库的 `apps/buddy` 目录运行：

```sh
node extensions/tools.mjs check ../../../counter
node extensions/tools.mjs build ../../../counter .output/extensions/counter
node extensions/tools.mjs pack .output/extensions/counter .output/extensions/counter.lexora-extension
```

在应用的「插件 → 安装插件包」中选择生成的文件，核对信息后确认安装。回到「任务」，输入 `/counter:open` 并选择对应命令，或从命令面板运行“打开计数面板”。

## 检查结果

1. 面板初始显示“计数：0”，点击后依次增加。
2. 切换到其他标签再回来，当前面板保留数字。
3. 再运行打开命令，检查两个实例互不覆盖。
4. 保留标签后重启应用，检查工作台恢复的实例状态。
5. 禁用插件，确认视图和入口撤回；重新启用后能再次打开。

修改源码后重新构建安装包，更新已安装版本时递增插件版本，并应用待生效更新。构建成功只代表产物可生成；以上交互应在实际宿主检查。

接下来阅读[核心概念](./concepts)，或为面板加入[设置与状态](./settings)。
