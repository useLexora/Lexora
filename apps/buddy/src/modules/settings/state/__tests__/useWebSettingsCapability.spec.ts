import type { WebSettingsSnapshot } from '@buddy-shared/network/webProtocol'
import { DEFAULT_WEB_SETTINGS } from '@buddy-shared/network/webProtocol'
import { describe, expect, it } from 'vitest'
import { shallowRef } from 'vue'
import { useWebSettingsCapability } from '../useWebSettingsCapability'

function fixture() {
  let state: WebSettingsSnapshot = { settings: structuredClone(DEFAULT_WEB_SETTINGS), tavilyKeyConfigured: false }
  let saveGate: Promise<void> = Promise.resolve()
  const capability = useWebSettingsCapability({
    language: shallowRef('zh-CN'),
    api: {
      onChanged: () => () => {},
      revealCredential: async () => 'fixture-only-key',
      read: async () => structuredClone(state),
      save: async (settings) => {
        const input = structuredClone(settings)
        await saveGate
        state = { ...state, settings: input }
        return structuredClone(state)
      },
      saveCredential: async (key) => {
        state = { ...state, tavilyKeyConfigured: Boolean(key) }
        return structuredClone(state)
      },
    },
  })
  return {
    capability,
    gate: (promise: Promise<void>) => { saveGate = promise },
    state: () => state,
  }
}

describe('web settings UI state', () => {
  it('immediately reorders, persists plain IPC data and preserves subsequent toggles', async () => {
    const { capability, gate, state } = fixture()
    await capability.load()
    const pending = Promise.withResolvers<void>()
    gate(pending.promise)
    const saving = capability.reorderSearch('brave', 'native', 'before')
    expect(capability.searchSources.value.map(source => source.provider)).toEqual(['brave', 'native', 'google', 'bing', 'duckduckgo'])
    expect(capability.busy.value).toBe(true)
    expect(state().settings.search[0]?.provider).toBe('native')
    pending.resolve()
    expect(await saving).toBe(true)
    expect(state().settings.search[0]?.provider).toBe('brave')
    expect(await capability.setSearchEnabled('brave', false)).toBe(true)
    expect(state().settings.search[0]).toEqual({ provider: 'brave', enabled: false })
    await capability.load()
    expect(capability.searchSources.value[0]).toEqual({ provider: 'brave', enabled: false })
  })
  it('rolls back failed saves and can persist a later retry', async () => {
    const { capability, gate } = fixture()
    await capability.load()
    const pending = Promise.withResolvers<void>()
    gate(pending.promise)
    const saving = capability.reorderSearch('bing', 'native', 'before')
    expect(capability.searchSources.value[0]?.provider).toBe('bing')
    pending.reject(new Error('fixture save failure'))
    expect(await saving).toBe(false)
    expect(capability.searchSources.value[0]?.provider).toBe('native')
    expect(capability.error.value).toBeTruthy()
    gate(Promise.resolve())
    expect(await capability.reorderSearch('bing', 'native', 'before')).toBe(true)
    expect(capability.error.value).toBeNull()
  })
  it('refreshes a committed permission disable even when the credential write rejects', async () => {
    let changed = () => {}
    let state: WebSettingsSnapshot = { settings: structuredClone(DEFAULT_WEB_SETTINGS), tavilyKeyConfigured: true }
    state.settings.fetch.remote = true
    const capability = useWebSettingsCapability({ language: shallowRef('zh-CN'), api: {
      onChanged: (listener) => {
        changed = listener

        return () => {
          changed = () => {}
        }
      },
      revealCredential: async () => 'fixture-only-key',
      read: async () => structuredClone(state),
      save: async settings => ({ settings, tavilyKeyConfigured: true }),
      saveCredential: async () => {
        state = { ...state, settings: { ...state.settings, fetch: { ...state.settings.fetch, remote: false } } }
        changed()
        throw new Error('credential write failed')
      },
    } })
    await capability.load()
    expect(capability.snapshot.value?.settings.fetch.remote).toBe(true)
    expect(await capability.saveCredential(null)).toBe(false)
    expect(capability.snapshot.value?.settings.fetch.remote).toBe(false)
    expect(capability.error.value).toBeTruthy()
    capability.dispose()
  })

  it('reveals credentialed sources without enabling them or remote extraction', async () => {
    const { capability } = fixture()
    await capability.load()
    expect(capability.searchSources.value.some(source => source.provider === 'tavily')).toBe(false)
    await capability.saveCredential('fixture-only-key')
    expect(capability.searchSources.value.find(source => source.provider === 'tavily')).toEqual({ provider: 'tavily', enabled: false })
    expect(capability.snapshot.value?.settings.fetch.remote).toBe(false)
    await capability.saveCredential(null)
    expect(capability.searchSources.value.some(source => source.provider === 'tavily')).toBe(false)
  })
})
