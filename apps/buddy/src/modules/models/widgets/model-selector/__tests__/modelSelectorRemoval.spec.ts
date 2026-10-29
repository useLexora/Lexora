// @vitest-environment jsdom
import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, shallowReactive } from 'vue'
import { resolveProviderIcon } from '@/shared/ui/icon/providerIcons'
import { modelKey } from '../../../model/modelSelection'
import DesktopModelSelector from '../DesktopModelSelector.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

describe('model selector after service removal', () => {
  it.each([false, true])('replaces a deleted model label and offers only available choices (remaining: %s)', async (hasRemaining) => {
    const deleted = model('builtin-removed', 'Removed model')
    const remaining = model('service-remaining', 'Remaining model')
    const props = shallowReactive({
      disabled: false,
      language: 'zh-CN' as const,
      models: [deleted, remaining] as ReadonlyArray<LocalRuntimeModelOption>,
      providers: [],
      selectedEffort: 'high' as const,
      selectedModel: deleted as LocalRuntimeModelOption | null,
      selectedModelId: modelKey(deleted),
      selectedServiceTier: null,
    })
    const root = document.createElement('div')
    root.className = 'buddy-app'
    document.body.append(root)
    const app = createApp({ setup: () => () => h(DesktopModelSelector, props) })
    app.mount(root)
    cleanups.push(() => {
      app.unmount()
      root.remove()
    })
    await nextTick()
    const trigger = root.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
    expect(trigger.textContent).toContain('Removed model')

    props.selectedModel = null
    props.models = hasRemaining ? [remaining] : []
    await nextTick()
    expect(trigger.textContent?.trim()).toBe('选择模型')
    expect(root.textContent).not.toContain('builtin-removed')
    expect(trigger.disabled).toBe(!hasRemaining)
    if (hasRemaining) {
      trigger.click()
      await nextTick()
      expect(root.querySelector('[role="menuitemradio"]')?.textContent).toContain('Remaining model')

      props.models = []
      await nextTick()
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      expect(root.querySelector('[role="menu"]')).toBeNull()
    }
  })
})

describe('model selector provider icon', () => {
  it('follows selected models and builtin instance identity without guessing custom brands', async () => {
    const selected = model('renamed-openai-instance', 'GPT')
    const props = shallowReactive({
      disabled: false,
      language: 'zh-CN' as const,
      models: [selected] as ReadonlyArray<LocalRuntimeModelOption>,
      providers: [provider(selected.providerId, 'openai')] as ReadonlyArray<LocalProvider>,
      selectedEffort: null,
      selectedModel: selected as LocalRuntimeModelOption | null,
      selectedModelId: modelKey(selected),
      selectedServiceTier: null,
    })
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({ setup: () => () => h(DesktopModelSelector, props) })
    app.mount(root)
    cleanups.push(() => {
      app.unmount()
      root.remove()
    })
    const brand = () => root.querySelector('.desktop-model-selector__trigger .provider-icon__brand')
    const fallback = () => root.querySelector('.desktop-model-selector__trigger .provider-icon__fallback')
    expect(brand()?.getAttribute('style')).toContain(resolveProviderIcon('openai'))

    // Provider metadata can arrive after the selected model, or be replaced independently.
    props.providers = [{ ...provider(selected.providerId, 'deepseek'), displayName: 'My renamed service' }]
    await nextTick()
    expect(brand()?.getAttribute('style')).toContain(resolveProviderIcon('deepseek'))

    const anthropic = model('anthropic', 'Claude')
    props.selectedModel = anthropic
    props.selectedModelId = modelKey(anthropic)
    props.models = [anthropic]
    props.providers = []
    await nextTick()
    expect(brand()?.getAttribute('style')).toContain(resolveProviderIcon('anthropic'))

    // Even a custom OpenAI-compatible service must not be labelled as OpenAI.
    props.providers = [{ ...provider('anthropic', null), custom: true, api: 'openai-completions' }]
    await nextTick()
    expect(brand()).toBeNull()
    expect(fallback()).not.toBeNull()

    props.providers = [provider('anthropic', 'radius')]
    await nextTick()
    expect(brand()).toBeNull()
    expect(fallback()).not.toBeNull()

    props.providers = []
    props.selectedModel = null
    await nextTick()
    expect(brand()).toBeNull()
    expect(fallback()).not.toBeNull()
    expect(root.querySelector('button')?.getAttribute('aria-label')).toBe('选择模型')

    props.selectedModel = model('deepseek', 'DeepSeek')
    await nextTick()
    expect(brand()?.getAttribute('style')).toContain(resolveProviderIcon('deepseek'))
    expect(fallback()).toBeNull()
  })
})

function provider(id: string, builtinProviderId: string | null): LocalProvider {
  return {
    activeRunCount: 0,
    added: true,
    api: null,
    authTypes: ['api_key'],
    baseUrl: null,
    builtinProviderId,
    canSyncModels: true,
    custom: false,
    description: null,
    displayName: 'Renamed service',
    enabled: true,
    enabledModelCount: 1,
    id,
    modelCount: 1,
    requestHeaders: [],
    setupComplete: true,
    status: 'available',
    storedCredentialType: 'api_key',
    syncUnavailableReason: null,
  }
}

function model(providerId: string, displayName: string): LocalRuntimeModelOption {
  return {
    api: 'openai-completions',
    available: true,
    type: 'chat',
    sourceType: 'chat',
    typeOverride: null,
    catalogMatch: 'not_applicable',
    catalog: { source: null, selection: null, candidates: [] },
    metadataKnown: true,
    capabilities: ['text'],
    fileInputMimeTypes: [],
    capabilityOverrides: null,
    sourceCapabilities: { image: false, reasoningOptions: ['off', 'high'] },
    contextWindow: 4096,
    displayName,
    enabled: true,
    hasParameterOverride: false,
    lastSeenAt: null,
    maxTokens: 1024,
    modelId: 'model',
    overrideContextWindow: null,
    overrideMaxTokens: null,
    providerId,
    reasoningOptions: ['off', 'high'],
    serviceTiers: [],
    source: 'builtin',
    sourceContextWindow: 4096,
    sourceMaxTokens: 1024,
    sourceParametersUpdated: false,
  }
}
