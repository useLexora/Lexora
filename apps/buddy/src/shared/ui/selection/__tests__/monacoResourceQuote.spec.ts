import type { BuddyResourceQuote } from '@buddy-shared/conversation/buddyUserContent'
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { SelectionReferenceEditSource } from '../workbenchSelectionReferences'
import { describe, expect, it, vi } from 'vitest'
import { registerMonacoResourceQuote } from '../useMonacoResourceQuote'

describe('monaco component-menu reference contribution', () => {
  it.each([true, false])('freezes selection before opening the component menu (editable=%s)', (editable) => {
    let context!: (event: { event: { posx: number, posy: number, preventDefault: () => void } }) => void
    let text = 'first selected text'
    const show = vi.fn()
    const prepare = vi.fn((_quote: BuddyResourceQuote, _x: number, _y: number, _editable?: boolean, _source?: SelectionReferenceEditSource) => show)
    const model = { getValueInRange: () => text, getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 10, endColumn: 1 }) }
    const focus = vi.fn()
    const setSelection = vi.fn()
    const trigger = vi.fn()
    const dispose = vi.fn()
    const addAction = vi.fn()
    const editor = {
      onContextMenu: (listener: typeof context) => {
        context = listener
        return { dispose }
      },
      addAction,
      getSelection: () => ({ startLineNumber: 3, startColumn: 2, endLineNumber: 4, endColumn: 7 }),
      getModel: () => model,
      focus,
      setSelection,
      trigger,
    } as unknown as Monaco.editor.IStandaloneCodeEditor
    const source = { kind: 'file' as const, title: 'file.ts', format: 'source' as const, file: { spaceId: 's', directoryId: 'd', revision: 1, path: 'file.ts' } }
    const contribution = registerMonacoResourceQuote(editor, { source: () => source, prepare, editable: () => editable })
    const preventDefault = vi.fn()
    context({ event: { posx: 20, posy: 30, preventDefault } })
    expect(prepare.mock.calls[0]).toEqual([expect.objectContaining({ text: 'first selected text', source, range: expect.objectContaining({ startLineNumber: 3, endLineNumber: 4 }) }), 20, 30, editable, expect.objectContaining({ restore: expect.any(Function), executeLocal: expect.any(Function) })])
    const editing = prepare.mock.calls[0]![4]!
    expect(focus).not.toHaveBeenCalled()
    expect(editing.restore()).toBe(true)
    expect(focus).toHaveBeenCalledOnce()
    expect(editing.executeLocal?.('undo')).toBe(true)
    expect(trigger).toHaveBeenCalledWith('selection-menu', 'undo', null)
    expect(editing.executeLocal?.('selectAll')).toBe(true)
    expect(setSelection).toHaveBeenLastCalledWith(model.getFullModelRange())
    text = 'changed after context menu opened'
    expect(editing.restore()).toBe(false)
    expect(show).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(addAction).not.toHaveBeenCalled()
    contribution.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
