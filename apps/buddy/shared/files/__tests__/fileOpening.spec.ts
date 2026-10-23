import type { FileOpeningProvider, FileOpeningSnapshot } from '../fileOpening'
import { describe, expect, it } from 'vitest'
import { builtinFileOpeningProviders, resolveFileOpening } from '../fileOpening'

const plugin: FileOpeningProvider = { id: 'test.reader', title: 'Reader', extensions: ['.md', '.custom'], locations: ['inline', 'standalone'], builtin: false, available: true, renderer: 'extension', extensionId: 'test.plugin' }
function snapshot(defaults: FileOpeningSnapshot['defaults'] = {}, extra: FileOpeningProvider[] = []): FileOpeningSnapshot {
  return { providers: [...builtinFileOpeningProviders, plugin, ...extra], defaults }
}

describe('file opening resolution', () => {
  it('uses the browser for standalone HTML but keeps inline HTML in the text viewer', () => {
    expect(resolveFileOpening(snapshot(), 'index.htm', 'standalone').provider?.id).toBe('lexora.browser')
    expect(resolveFileOpening(snapshot(), 'index.htm', 'inline').provider?.id).toBe('lexora.text')
  })

  it('keeps each location independent and never automatically selects a third-party candidate', () => {
    const state = snapshot({ '.md': { inline: plugin.id } })
    expect(resolveFileOpening(state, 'README.md', 'inline').provider?.id).toBe(plugin.id)
    expect(resolveFileOpening(state, 'README.md', 'standalone').provider?.id).toBe('lexora.markdown')
    expect(resolveFileOpening(state, 'data.custom', 'standalone').provider).toBeNull()
    expect(resolveFileOpening(state, 'data.md.exe', 'inline').provider).toBeNull()
  })

  it('preserves an unavailable choice, falls back only to a builtin, and resumes when restored', () => {
    const state = snapshot({ '.md': { inline: plugin.id } })
    state.providers = state.providers.map(provider => provider.id === plugin.id ? { ...provider, available: false } : provider)
    expect(resolveFileOpening(state, 'README.md', 'inline')).toMatchObject({ preferredId: plugin.id, unavailable: true, provider: { id: 'lexora.markdown' } })
    expect(state.defaults['.md']?.inline).toBe(plugin.id)
    state.providers = [...builtinFileOpeningProviders, plugin]
    expect(resolveFileOpening(state, 'README.md', 'inline')).toMatchObject({ unavailable: false, provider: { id: plugin.id } })
  })

  it('retains the missing preference after uninstalling the only provider of a suffix', () => {
    const state = { providers: [...builtinFileOpeningProviders], defaults: { '.custom': { standalone: plugin.id } } }
    expect(resolveFileOpening(state, 'data.custom', 'standalone')).toEqual({ extension: '.custom', preferredId: plugin.id, candidates: [], provider: null, unavailable: true })
  })

  it('rejects a preference with incompatible suffix or location and prefers the longest exact suffix', () => {
    const other = { ...plugin, id: 'test.declaration', extensions: ['.d.ts'], locations: ['standalone'] as const }
    expect(resolveFileOpening(snapshot({ '.md': { inline: 'lexora.media' } }), 'readme.md', 'inline')).toMatchObject({ unavailable: true, provider: { id: 'lexora.markdown' } })
    expect(resolveFileOpening(snapshot({ '.d.ts': { standalone: other.id } }, [other]), 'TYPES.D.TS', 'standalone').provider?.id).toBe(other.id)
    expect(resolveFileOpening(snapshot({ '.d.ts': { inline: other.id } }, [other]), 'types.d.ts', 'inline')).toMatchObject({ unavailable: true, provider: { id: 'lexora.text' } })
  })

  it('keeps unsupported positions and unavailable compound suffixes from hiding builtin matches', () => {
    const other = { ...plugin, id: 'test.declaration', extensions: ['.d.ts'], locations: ['standalone'] as const }
    expect(resolveFileOpening(snapshot({}, [other]), 'types.d.ts', 'inline')).toMatchObject({ extension: '.ts', preferredId: null, provider: { id: 'lexora.text' } })
    expect(resolveFileOpening(snapshot({}, [{ ...other, available: false }]), 'types.d.ts', 'standalone')).toMatchObject({ provider: { id: 'lexora.text' } })
    const retained = { providers: [...builtinFileOpeningProviders], defaults: { '.d.ts': { standalone: other.id } } }
    expect(resolveFileOpening(retained, 'types.d.ts', 'inline')).toMatchObject({ extension: '.ts', unavailable: false, provider: { id: 'lexora.text' } })
    expect(resolveFileOpening(retained, 'types.d.ts', 'standalone')).toMatchObject({ preferredId: other.id, unavailable: true, provider: { id: 'lexora.text' } })
    expect(retained.defaults['.d.ts'].standalone).toBe(other.id)
    retained.providers.push(other)
    expect(resolveFileOpening(retained, 'types.d.ts', 'standalone').provider?.id).toBe(other.id)
  })

  it('orders builtin matches by suffix specificity then recommendation while respecting explicit preferences', () => {
    const specific = { ...plugin, id: 'lexora.special', builtin: true, extensions: ['.special.md'] }
    const other = { ...plugin, id: 'test.special', extensions: ['.special.md'] }
    const state = snapshot({}, [specific, other])
    expect(resolveFileOpening(state, 'notes.special.md', 'inline').provider?.id).toBe(specific.id)
    expect(resolveFileOpening(state, 'notes.md', 'inline').provider?.id).toBe('lexora.markdown')
    state.defaults['.md'] = { inline: plugin.id }
    expect(resolveFileOpening(state, 'notes.special.md', 'inline')).toMatchObject({ preferredId: null, provider: { id: specific.id } })
    state.defaults['.special.md'] = { inline: other.id }
    expect(resolveFileOpening(state, 'notes.special.md', 'inline').provider?.id).toBe(other.id)
  })
})
