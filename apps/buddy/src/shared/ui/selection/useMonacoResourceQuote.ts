import type { BuddyResourceQuote, BuddyTextQuote } from '@buddy-shared/conversation/buddyUserContent'
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import { MenuId, MenuRegistry } from 'monaco-editor/platform/actions/common/actions.js'
import { CommandsRegistry } from 'monaco-editor/platform/commands/common/commands.js'
import { ContextKeyExpr } from 'monaco-editor/platform/contextkey/common/contextkey.js'
import { shallowRef, watchEffect } from 'vue'

export interface MonacoResourceQuoteMenu {
  label: string
  actions: readonly { label: string, run: () => void }[]
}

export type CaptureMonacoResourceQuote = (quote: BuddyResourceQuote) => MonacoResourceQuoteMenu | null

let sequence = 0

export function registerMonacoResourceQuote(editor: Monaco.editor.IStandaloneCodeEditor, options: {
  source: () => BuddyTextQuote['source']
  capture: CaptureMonacoResourceQuote
}): Monaco.IDisposable {
  const id = `lexora.quoteSelection.${++sequence}`
  const submenu = new MenuId(id)
  const when = ContextKeyExpr.deserialize(`editorId == ${editor.getId()} && editorHasSelection`)
  const items: Monaco.IDisposable[] = []
  let disposed = false
  let revision = 0
  function clear() {
    for (const item of items.splice(0))
      item.dispose()
  }
  function refresh() {
    clear()
    if (disposed)
      return
    const range = editor.getSelection()
    const model = editor.getModel()
    const text = range && model?.getValueInRange(range)
    if (!range || !text?.trim())
      return
    const menu = options.capture({
      id: crypto.randomUUID(),
      text,
      source: options.source(),
      range: {
        startLineNumber: range.startLineNumber,
        startColumn: range.startColumn,
        endLineNumber: range.endLineNumber,
        endColumn: range.endColumn,
      },
    })
    if (!menu)
      return
    // Never reuse a command ID: an already-open menu must not reroute to a new target.
    const snapshotId = `${id}.${++revision}`
    const multiple = menu.actions.length > 1
    if (multiple) {
      items.push(MenuRegistry.appendMenuItem(MenuId.EditorContext, {
        submenu,
        title: menu.label,
        when,
        group: '9_cutcopypaste',
        order: 4,
      }))
    }
    const actions = menu.actions.length ? menu.actions : [{ label: menu.label, run: () => {} }]
    actions.forEach((action, index) => {
      const commandId = `${snapshotId}.${index}`
      items.push(CommandsRegistry.registerCommand(commandId, action.run))
      items.push(MenuRegistry.appendMenuItem(multiple ? submenu : MenuId.EditorContext, {
        command: {
          id: commandId,
          title: multiple ? action.label : menu.label,
          precondition: menu.actions.length ? undefined : ContextKeyExpr.deserialize('false'),
        },
        when,
        group: '9_cutcopypaste',
        order: multiple ? index : 4,
      }))
    })
  }
  // Re-run the effect on selection changes so it tracks the latest target/source refs,
  // even when the editor initially mounted without a selection.
  const refreshVersion = shallowRef(0)
  const scheduleRefresh = () => {
    refreshVersion.value++
  }
  // Capture before Monaco builds its menu, including keyboard invocation.
  const element = editor.getDomNode()
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
      scheduleRefresh()
  }
  element?.addEventListener('contextmenu', scheduleRefresh, true)
  element?.addEventListener('keydown', keydown, true)
  const selection = editor.onDidChangeCursorSelection(scheduleRefresh)
  // Do not refresh on focus: native menus restore editor focus before executing
  // the clicked command. Refreshing there would unregister that very command.
  // Track reactive target/layout/source changes without changing native actions.
  const stop = watchEffect(() => {
    void refreshVersion.value
    refresh()
  }, { flush: 'sync' })
  let registration: Monaco.IDisposable
  const dispose = () => {
    if (disposed)
      return
    disposed = true
    stop()
    selection.dispose()
    element?.removeEventListener('contextmenu', scheduleRefresh, true)
    element?.removeEventListener('keydown', keydown, true)
    registration.dispose()
    clear()
  }
  registration = editor.onDidDispose(dispose)
  return { dispose }
}
