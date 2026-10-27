---
title: "Your first plugin"
description: "Build and install a counter panel with a command and independent view state."
---

# Your first plugin

Build a counter panel that opens from a command, increments on click and retains its instance state when switching tabs. You will use a manifest, background entry, view and package tools.

## Prepare the environment

Install Lexora and get the [source repository](https://github.com/useLexora/Lexora). Use the Node.js and pnpm versions specified by its root package.json engines and packageManager, then install workspace dependencies:

```sh
git clone https://github.com/useLexora/Lexora.git
cd Lexora
pnpm install
```

An existing independent Lexora Plugin SDK can also check and package this plugin; see [Build and distribute](./distribution).

Create a counter directory beside the Lexora checkout. Copy apps/buddy/service/resources/skills/plugin-creator/references/api.d.ts from the checkout to counter/lexora.d.ts. It is a type declaration, not a runtime dependency.

```text
counter/
├── extension.json
├── main.ts
├── view.ts
└── lexora.d.ts
```

## Declare the plugin

Create extension.json:

```json
{
  "schemaVersion": 1,
  "format": "source",
  "id": "example.counter",
  "name": "Counter panel",
  "version": "1.0.0",
  "apiVersion": 4,
  "engines": { "lexora": ">=0.16.2" },
  "entry": "main.ts",
  "permissions": {},
  "contributes": {
    "commands": [{
      "id": "example.counter.open",
      "title": "Open counter panel",
      "slash": { "name": "open", "description": "Open counter panel" }
    }],
    "views": [{
      "id": "example.counter.panel",
      "title": "Counter panel",
      "entry": "view.ts",
      "resource": "none"
    }]
  }
}
```

No file, network or model access is needed. The tutorial uses example.counter; generate a separate identity through the application or SDK createExtensionId for your own project, update contribution IDs, and preserve it thereafter.

## Register the command

Create main.ts:

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

Registration matches the manifest command. The host disposes subscriptions when the plugin stops.

## Render and persist state

Create view.ts:

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
  button.textContent = `Count: ${count}`
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
      button.textContent = `Count: ${count}`
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

The count belongs to this tab instance. The button waits for persistence before displaying the new value, retains the old value on failure, and stops updating after the view ends. A newly opened panel is independent.

## Build and install

From the Lexora checkout's apps/buddy directory:

```sh
node extensions/tools.mjs check ../../../counter
node extensions/tools.mjs build ../../../counter .output/extensions/counter
node extensions/tools.mjs pack .output/extensions/counter .output/extensions/counter.lexora-extension
```

In Plugins, choose Install plugin package and review the generated file. Return to Tasks. Run /counter:open by choosing its command suggestion, or run Open counter panel from the command palette.

## Check the result

1. The panel starts at Count: 0 and increments on each click.
2. Switch tabs and return; the current panel retains its count.
3. Open another panel and check that instances are independent.
4. Keep the tabs open, restart the application and check restored instance state.
5. Disable the plugin, check that views and entries withdraw, then enable and open it again.

Rebuild after source changes. Increment the plugin version when updating an installation, and apply any pending update. A successful build only proves package generation; verify interaction in the real host.

Continue with [Core concepts](./concepts) or [Settings and state](./settings).
