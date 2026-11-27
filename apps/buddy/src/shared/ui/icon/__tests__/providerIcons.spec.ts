// @vitest-environment jsdom
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import ProviderIcon from '../ProviderIcon.vue'
import { resolveProviderIcon } from '../providerIcons'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

describe('provider icons', () => {
  it('covers the installed builtin catalog except the explicitly unbranded Radius fallback', () => {
    // Radius is not in the pinned Lobe Icons set. Do not substitute another brand.
    expect(builtinProviders().filter(provider => !resolveProviderIcon(provider.id)).map(provider => provider.id))
      .toEqual(['radius'])
  })

  it.each([
    ['openai', 'openai-codex'],
    ['minimax', 'minimax-cn'],
    ['moonshotai', 'moonshotai-cn'],
    ['opencode', 'opencode-go'],
    ['qwen-token-plan', 'qwen-token-plan-cn'],
    ['qwen-token-plan', 'qwen-token-plan-individual'],
    ['qwen-token-plan', 'qwen-token-plan-individual-cn'],
    ['xiaomi', 'xiaomi-token-plan-ams'],
    ['xiaomi', 'xiaomi-token-plan-cn'],
    ['xiaomi', 'xiaomi-token-plan-sgp'],
    ['zai', 'zai-coding-cn'],
    ['cloudflare-ai-gateway', 'cloudflare-workers-ai'],
  ])('shares the correct brand for %s and %s', (provider, alias) => {
    expect(resolveProviderIcon(provider)).toBeTruthy()
    expect(resolveProviderIcon(alias)).toBe(resolveProviderIcon(provider))
  })

  it.each(['radius', 'custom-provider', '', '__proto__', 'constructor', 'toString'])(
    'uses the generic fallback for an unmapped id: %s',
    (providerId) => {
      expect(resolveProviderIcon(providerId)).toBeNull()
    },
  )

  it('reacts to id replacement and decorates the adjacent name without an extra accessible label', async () => {
    const providerId = shallowRef('openai')
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({
      setup: () => () => h(ProviderIcon, { providerId: providerId.value }),
    })
    app.mount(root)
    cleanups.push(() => {
      app.unmount()
      root.remove()
    })

    const icon = () => root.querySelector('.provider-icon__brand') as HTMLElement | null
    expect(root.querySelector('.provider-icon')?.getAttribute('aria-hidden')).toBe('true')
    expect(icon()?.style.getPropertyValue('--provider-icon-mask')).toContain(resolveProviderIcon('openai'))
    expect(root.querySelector('img')).toBeNull()

    providerId.value = 'deepseek'
    await nextTick()
    expect(icon()?.style.getPropertyValue('--provider-icon-mask')).toContain(resolveProviderIcon('deepseek'))

    providerId.value = 'radius'
    await nextTick()
    expect(icon()).toBeNull()
    expect(root.querySelector('svg.provider-icon__fallback')).not.toBeNull()

    providerId.value = 'anthropic'
    await nextTick()
    expect(icon()?.style.getPropertyValue('--provider-icon-mask')).toContain(resolveProviderIcon('anthropic'))
    expect(root.querySelector('.provider-icon__fallback')).toBeNull()
  })
})
