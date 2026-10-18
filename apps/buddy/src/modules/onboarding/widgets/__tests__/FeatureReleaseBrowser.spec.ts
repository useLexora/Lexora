// @vitest-environment jsdom
import type { FeatureGuide } from '@buddy-shared/onboarding/featureDiscovery'
import { afterEach, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import FeatureReleaseBrowser from '../FeatureReleaseBrowser.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

it('browses and searches many releases without rendering their entire feature history', async () => {
  const features: FeatureGuide[] = Array.from({ length: 40 }, (_, index) => [
    { id: 'navigation-layout' as const, version: `0.${index + 1}.0` },
    { id: 'npc-team' as const, version: `0.${index + 1}.0` },
  ]).flat()
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ render: () => h(FeatureReleaseBrowser, { features, unread: [], busy: false, language: 'zh-CN' }) })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  await nextTick()
  expect(root.querySelector('nav button')?.textContent).toContain('v0.40.0')
  expect(root.querySelectorAll('nav button')).toHaveLength(40)
  expect(root.querySelectorAll('article')).toHaveLength(2)
  const releases = Array.from(root.querySelectorAll<HTMLButtonElement>('nav button'))
  releases.find(button => button.textContent?.includes('v0.9.0'))!.click()
  await nextTick()
  expect(root.querySelector('h2')?.textContent).toContain('0.9.0')
  const input = root.querySelector('input')!
  input.value = 'NPC'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  expect(root.querySelectorAll('article')).toHaveLength(1)
  input.value = '0.12.0'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  expect(root.querySelectorAll('nav button')).toHaveLength(1)
  expect(root.querySelector('h2')?.textContent).toContain('0.12.0')
  expect(root.querySelectorAll('article')).toHaveLength(2)
})
