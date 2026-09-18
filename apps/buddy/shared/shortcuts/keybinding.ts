export type ShortcutScope = 'application' | 'workbench' | 'main' | 'context'
export interface ShortcutEntry {
  id: string
  label: string
  binding: string
  alternatives: readonly string[]
  defaultBinding: string
  scope: ShortcutScope
  modified: boolean
}
export interface ShortcutInput {
  code: string
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  isComposing: boolean
  keyCode?: number
  getModifierState?: (key: string) => boolean
}
const modifiers = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'] as const
const codeKeys: Readonly<Record<string, string>> = {
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: '\'',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Space: 'Space',
}
const namedKeys = new Set(['Tab', 'Enter', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ...Object.values(codeKeys)])
export function isKeybinding(value: string): boolean {
  if (value === '')
    return true
  const parts = value.split('+')
  const key = parts.pop()!
  if (!/^[A-Z0-9]$/.test(key) && !/^F(?:[1-9]|1\d|2[0-4])$/.test(key) && !namedKeys.has(key))
    return false
  if (!parts.every(part => modifiers.includes(part as typeof modifiers[number])) || new Set(parts).size !== parts.length)
    return false
  return parts.some(part => part !== 'Shift') || /^F\d+$/.test(key)
}
export function resolvedKeybinding(binding: string, platform: string): string {
  const parts = binding.split('+')
  const key = parts.pop()!
  const selected = new Set(parts.map(part => part === 'Mod' ? platform === 'darwin' ? 'Meta' : 'Ctrl' : part))
  return [...modifiers.filter(part => selected.has(part)), key].join('+')
}
export function keybindingFromInput(input: ShortcutInput, platform: string): string | null {
  if (input.isComposing || input.keyCode === 229 || input.getModifierState?.('AltGraph') || input.key === 'Process' || input.key === 'Dead')
    return null
  const key = codeKeys[input.code] ?? (/^Key[A-Z]$/.test(input.code) ? input.code.slice(3) : /^Digit\d$/.test(input.code) ? input.code.slice(5) : input.code || input.key)
  const primary = platform === 'darwin' ? input.metaKey : input.ctrlKey
  const parts = [primary ? 'Mod' : '', platform === 'darwin' && input.ctrlKey ? 'Ctrl' : '', input.altKey ? 'Alt' : '', input.shiftKey ? 'Shift' : '', platform !== 'darwin' && input.metaKey ? 'Meta' : '', key].filter(Boolean)
  const value = parts.join('+')
  return isKeybinding(value) ? value : null
}
export function matchesKeybinding(input: ShortcutInput, binding: string, platform: string): boolean {
  const captured = keybindingFromInput(input, platform)
  return !!binding && captured !== null && resolvedKeybinding(binding, platform) === resolvedKeybinding(captured, platform)
}
export function formatKeybinding(binding: string, platform: string): string {
  return resolvedKeybinding(binding, platform).split('+').map(key => key === 'Meta' ? '⌘' : key === 'ArrowUp' ? '↑' : key === 'ArrowDown' ? '↓' : key === 'ArrowLeft' ? '←' : key === 'ArrowRight' ? '→' : key).join(' + ')
}
export function shortcutScopesOverlap(left: ShortcutScope, right: ShortcutScope): boolean {
  return !((left === 'main' && right === 'context') || (left === 'context' && right === 'main'))
}
export function conflictingShortcuts(entries: readonly ShortcutEntry[], id: string, binding: string, platform: string): ShortcutEntry[] {
  const current = entries.find(entry => entry.id === id)
  if (!current || !binding)
    return []
  return entries.filter(entry => entry.id !== id && shortcutScopesOverlap(current.scope, entry.scope) && [entry.binding, ...entry.alternatives].some(value => value && resolvedKeybinding(value, platform) === resolvedKeybinding(binding, platform)))
}
