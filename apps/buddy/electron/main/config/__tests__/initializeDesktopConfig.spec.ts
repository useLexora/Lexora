import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it } from 'vitest'
import { initializeDesktopConfig, resolveSystemLanguage } from '../initializeDesktopConfig'
import { LexoraConfigStore } from '../LexoraConfigStore'

async function fixture() {
  const directory = await createTemporaryDirectory('lexora-onboarding-')
  const options = { configPath: join(directory, 'config.toml'), buddyHome: join(directory, 'buddy'), languages: ['de-DE', 'en-GB', 'zh-CN'] }
  return { options, store: new LexoraConfigStore(options) }
}

it('initializes only fresh profiles and persists language, incomplete setup and completion across restarts', async () => {
  const { options, store } = await fixture()
  expect((await initializeDesktopConfig(store, options)).desktop).toMatchObject({ language: 'en-US', onboardingCompleted: false })
  await store.update({ desktop: { language: 'zh-CN' } })
  expect((await initializeDesktopConfig(new LexoraConfigStore(options), options)).desktop).toMatchObject({ language: 'zh-CN', onboardingCompleted: false })
  await store.update({ desktop: { onboardingCompleted: true, navigationLayout: 'immersive' }, pet: { enabled: false } })
  expect(await initializeDesktopConfig(new LexoraConfigStore(options), options)).toMatchObject({ desktop: { language: 'zh-CN', onboardingCompleted: true, navigationLayout: 'immersive' }, pet: { enabled: false } })
})

it('does not enroll or rewrite existing profiles, including empty configs and data without a config', async () => {
  for (const content of ['', '[desktop]\nlanguage="zh-CN"\n[pet]\nenabled=false\n']) {
    const { options, store } = await fixture()
    await writeFile(options.configPath, content)
    expect((await initializeDesktopConfig(store, options)).desktop).toMatchObject({ language: 'zh-CN', onboardingCompleted: true })
    expect(await readFile(options.configPath, 'utf8')).toBe(content)
  }
  const { options, store } = await fixture()
  await mkdir(options.buddyHome)
  await writeFile(join(options.buddyHome, 'buddy.sqlite3'), 'existing data')
  expect((await initializeDesktopConfig(store, options)).desktop.onboardingCompleted).toBe(true)
  await expect(readFile(options.configPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves corrupt configuration for recovery instead of resetting onboarding', async () => {
  const { options, store } = await fixture()
  const content = '[desktop\nlanguage = "en-US"'
  await writeFile(options.configPath, content)
  await expect(initializeDesktopConfig(store, options)).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  expect(await readFile(options.configPath, 'utf8')).toBe(content)
})

it.each([
  [['ja-JP', 'zh-Hant-TW', 'en-US'], 'zh-CN'],
  [['en_AU', 'zh-CN'], 'en-US'],
  [['fr-FR'], 'en-US'],
] as const)('matches supported system languages in priority order: %j', (languages, expected) => {
  expect(resolveSystemLanguage(languages)).toBe(expected)
})
