import { describe, expect, it } from 'vitest'
import { DESKTOP_SELECTION_EDIT_COMMANDS } from '../../shared/desktopApi'
import { desktopSelectionReferenceEditInputSchema } from '../../shared/desktopApiSchemas'
import { createDesktopContextMenuTemplate } from '../desktopContextMenu'

describe('selection editing command boundary', () => {
  it.each(DESKTOP_SELECTION_EDIT_COMMANDS)('accepts only the existing editing command %s', (command) => {
    expect(desktopSelectionReferenceEditInputSchema.parse({ command })).toEqual({ command })
  })

  it('rejects arbitrary commands, native roles, callbacks and unknown fields', () => {
    for (const input of [{ command: 'quit' }, { command: 'executeJavaScript' }, { command: 'copy', role: 'quit' }, { command: 'paste', callback: 'code' }])
      expect(desktopSelectionReferenceEditInputSchema.safeParse(input).success).toBe(false)
  })

  it.each([true, false])('leaves unrelated native context menus unchanged (editable=%s)', (isEditable) => {
    const original = createDesktopContextMenuTemplate({ isEditable, selectionText: 'selected' })
    expect(original.filter(item => item.role === 'copy')).toHaveLength(1)
    expect(original.some(item => item.role === 'undo')).toBe(isEditable)
    expect(original.some(item => item.role === 'paste')).toBe(isEditable)
  })
})
