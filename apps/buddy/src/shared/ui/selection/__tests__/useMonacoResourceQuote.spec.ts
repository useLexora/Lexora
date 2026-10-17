// @vitest-environment jsdom
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { MonacoResourceQuoteMenu } from '../useMonacoResourceQuote'
import { MenuId, MenuRegistry } from 'monaco-editor/platform/actions/common/actions.js'
import { CommandsRegistry } from 'monaco-editor/platform/commands/common/commands.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shallowRef } from 'vue'
import { registerMonacoResourceQuote } from '../useMonacoResourceQuote'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function fixture(editorId = 'test-editor') {
  const element = document.createElement('div')
  let selectionChanged = () => {}
  let editorDisposed = () => {}
  let focusEditor = () => {}
  let text = 'selected code'
  const model = { getValueInRange: () => text }
  const range = { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 8 }
  const editor = {
    getId: () => editorId,
    getDomNode: () => element,
    getModel: () => model,
    getSelection: () => range,
    onDidChangeCursorSelection: (callback: () => void) => {
      selectionChanged = callback
      return { dispose: vi.fn() }
    },
    onDidFocusEditorText: (callback: () => void) => {
      focusEditor = callback
      return { dispose: vi.fn() }
    },
    onDidDispose: (callback: () => void) => {
      editorDisposed = callback
      return { dispose: vi.fn() }
    },
  } as unknown as Monaco.editor.IStandaloneCodeEditor
  const first = vi.fn()
  const second = vi.fn()
  const menu = shallowRef<MonacoResourceQuoteMenu | null>({ label: 'Quote to conversation', actions: [{ label: 'Pane A', run: first }] })
  const capture = vi.fn(() => menu.value)
  const registration = registerMonacoResourceQuote(editor, {
    source: () => ({ kind: 'file', title: 'test.ts', format: 'source', file: { spaceId: 's', directoryId: 'd', revision: 1, path: 'test.ts' } }),
    capture,
  })
  cleanups.push(() => registration.dispose())
  const items = () => MenuRegistry.getMenuItems(MenuId.EditorContext).filter(item => item.command?.id.startsWith('lexora.quoteSelection.') || item.submenu?.id.startsWith('lexora.quoteSelection.'))
  return { element, menu, first, second, capture, registration, items, select: (value: string) => {
    text = value
    selectionChanged()
  }, disposeEditor: () => editorDisposed(), focusEditor: () => focusEditor() }
}

describe('monaco native quote menu', () => {
  it('runs the sole target from the original context menu without opening a second menu', () => {
    const f = fixture()
    const item = f.items()[0]!
    expect(item.command?.title).toBe('Quote to conversation')
    expect(item.submenu).toBeUndefined()
    CommandsRegistry.getCommand(item.command!.id)!.handler()
    expect(f.first).toHaveBeenCalledOnce()
    expect(f.capture).toHaveBeenCalledWith(expect.objectContaining({
      text: 'selected code',
      range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 8 },
    }))
  })

  it.each([false, true])('keeps the clicked command alive when the menu restores editor focus (split: %s)', (split) => {
    const f = fixture()
    if (split)
      f.menu.value = { label: 'Quote to conversation', actions: [{ label: 'Pane A', run: f.first }, { label: 'Pane B', run: f.second }] }
    const parent = f.items()[0]!
    const item = split ? MenuRegistry.getMenuItems(parent.submenu!)[1]! : parent
    const commandId = item.command!.id
    // Monaco's onWillRun hides the context view and restores focus BEFORE
    // MenuItemAction resolves its command from CommandsRegistry.
    f.focusEditor()
    const command = CommandsRegistry.getCommand(commandId)
    expect(command).toBeDefined()
    command!.handler()
    expect(split ? f.second : f.first).toHaveBeenCalledOnce()
  })

  it('places multiple targets in a native submenu and updates when targets change', () => {
    const f = fixture()
    f.menu.value = { label: 'Quote to conversation', actions: [{ label: 'Pane B', run: f.second }, { label: 'Pane A', run: f.first }] }
    const parent = f.items()[0]!
    expect(parent.submenu).toBeDefined()
    const children = MenuRegistry.getMenuItems(parent.submenu!)
    expect(children.map(item => item.command?.title)).toEqual(['Pane B', 'Pane A'])
    CommandsRegistry.getCommand(children[0]!.command!.id)!.handler()
    expect(f.second).toHaveBeenCalledOnce()
    expect(f.first).not.toHaveBeenCalled()
    f.menu.value = { label: 'No conversation', actions: [] }
    expect(f.items()[0]!.command?.precondition).toBeDefined()
    expect(MenuRegistry.getMenuItems(parent.submenu!)).toHaveLength(0)
  })

  it('does not reroute commands captured by an old menu after targets change', () => {
    const f = fixture()
    const oldId = f.items()[0]!.command!.id
    f.menu.value = { label: 'Quote to conversation', actions: [{ label: 'Pane B', run: f.second }] }
    expect(CommandsRegistry.getCommand(oldId)).toBeUndefined()
    CommandsRegistry.getCommand(f.items()[0]!.command!.id)!.handler()
    expect(f.second).toHaveBeenCalledOnce()
    expect(f.first).not.toHaveBeenCalled()
  })

  it('captures a fresh snapshot for mouse and keyboard menus and removes whitespace-only selections', () => {
    const f = fixture()
    f.capture.mockClear()
    f.element.dispatchEvent(new MouseEvent('contextmenu'))
    f.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true }))
    f.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu' }))
    expect(f.capture).toHaveBeenCalledTimes(3)
    f.select('   ')
    expect(f.items()).toHaveLength(0)
  })

  it('cleans up commands and menu entries when the editor is disposed', () => {
    const f = fixture()
    const id = f.items()[0]!.command!.id
    f.disposeEditor()
    f.registration.dispose()
    expect(f.items()).toHaveLength(0)
    expect(CommandsRegistry.getCommand(id)).toBeUndefined()
    f.element.dispatchEvent(new MouseEvent('contextmenu'))
    expect(f.items()).toHaveLength(0)
  })

  it('scopes contributions to their own editor and disposes them independently', () => {
    const first = fixture('editor-a')
    const second = fixture('editor-b')
    expect(first.items()).toHaveLength(2)
    expect(first.items()[0]!.when).not.toEqual(first.items()[1]!.when)
    first.registration.dispose()
    expect(second.items()).toHaveLength(1)
    CommandsRegistry.getCommand(second.items()[0]!.command!.id)!.handler()
    expect(second.first).toHaveBeenCalledOnce()
    expect(first.first).not.toHaveBeenCalled()
  })
})
