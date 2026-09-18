import type { ShortcutEntry, ShortcutInput } from '../keybinding'
import { describe, expect, it } from 'vitest'
import { conflictingShortcuts, formatKeybinding, isKeybinding, keybindingFromInput, matchesKeybinding } from '../keybinding'

const input: ShortcutInput = { key: 'N', code: 'KeyN', altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, isComposing: false }
describe('desktop keybindings', () => {
  it('resolves the primary modifier on Linux, Windows and macOS without treating Ctrl as Command', () => {
    expect(matchesKeybinding(input, 'Mod+N', 'linux')).toBe(true)
    expect(matchesKeybinding(input, 'Mod+N', 'win32')).toBe(true)
    expect(matchesKeybinding(input, 'Mod+N', 'darwin')).toBe(false)
    expect(matchesKeybinding({ ...input, ctrlKey: false, metaKey: true }, 'Mod+N', 'darwin')).toBe(true)
    expect(formatKeybinding('Mod+Shift+N', 'darwin')).toBe('Shift + ⌘ + N')
  })
  it('captures physical punctuation and rejects composition and unmodified typing', () => {
    expect(keybindingFromInput({ ...input, key: '|', code: 'Backslash', shiftKey: true }, 'linux')).toBe('Mod+Shift+\\')
    expect(keybindingFromInput({ ...input, isComposing: true }, 'linux')).toBeNull()
    expect(keybindingFromInput({ ...input, keyCode: 229 }, 'linux')).toBeNull()
    expect(keybindingFromInput({ ...input, altKey: true, getModifierState: key => key === 'AltGraph' }, 'win32')).toBeNull()
    expect(keybindingFromInput({ ...input, ctrlKey: false }, 'linux')).toBeNull()
    expect(isKeybinding('F12')).toBe(true)
    expect(isKeybinding('')).toBe(true)
    expect(isKeybinding('Ctrl+Ctrl+N')).toBe(false)
    expect(isKeybinding('Control+N')).toBe(false)
  })
  it('allows the same binding in disjoint panes and detects global or alternate binding conflicts', () => {
    const entry = (id: string, scope: ShortcutEntry['scope'], binding: string, alternatives: string[] = []): ShortcutEntry => ({ id, label: id, scope, binding, alternatives, defaultBinding: binding, modified: false })
    const entries = [entry('pane.close', 'main', 'Mod+W'), entry('context.close', 'context', 'Mod+W'), entry('devtools', 'application', 'Mod+Shift+I', ['F12'])]
    expect(conflictingShortcuts(entries, 'pane.close', 'Mod+W', 'linux')).toEqual([])
    expect(conflictingShortcuts(entries, 'pane.close', 'F12', 'linux').map(item => item.id)).toEqual(['devtools'])
    expect(conflictingShortcuts(entries, 'devtools', 'Ctrl+W', 'linux').map(item => item.id)).toEqual(['pane.close', 'context.close'])
    expect(conflictingShortcuts(entries, 'devtools', '', 'linux')).toEqual([])
  })
})
