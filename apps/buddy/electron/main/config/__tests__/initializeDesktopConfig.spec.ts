import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { parse } from 'smol-toml'
import { expect, it } from 'vitest'
import { initializeDesktopConfig } from '../initializeDesktopConfig'
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

it('persists the exit default without enrolling existing profiles or dropping unknown preferences', async () => {
  for (const content of ['', '[desktop]\nlanguage="zh-CN"\n[pet]\nenabled=false\n']) {
    const { options, store } = await fixture()
    await writeFile(options.configPath, content)
    expect((await initializeDesktopConfig(store, options)).desktop).toMatchObject({ language: 'zh-CN', onboardingCompleted: true })
    expect(parse(await readFile(options.configPath, 'utf8'))).toMatchObject({ ...parse(content), desktop: { ...(parse(content).desktop as object ?? {}), exit_behavior: 'stop_service' } })
  }
  const { options, store } = await fixture()
  await mkdir(options.buddyHome)
  await writeFile(join(options.buddyHome, 'buddy.sqlite3'), 'existing data')
  expect((await initializeDesktopConfig(store, options)).desktop.onboardingCompleted).toBe(true)
  expect(parse(await readFile(options.configPath, 'utf8'))).toEqual({ desktop: { exit_behavior: 'stop_service' } })
})

it('preserves corrupt configuration for recovery instead of resetting onboarding', async () => {
  const { options, store } = await fixture()
  const content = '[desktop\nlanguage = "en-US"'
  await writeFile(options.configPath, content)
  await expect(initializeDesktopConfig(store, options)).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  expect(await readFile(options.configPath, 'utf8')).toBe(content)
})

it('preserves an explicit exit choice across repeated initialization and partial updates', async () => {
  const { options, store } = await fixture()
  await writeFile(options.configPath, '[desktop]\nexit_behavior="keep_service"\nfuture=true\n')
  const before = await readFile(options.configPath, 'utf8')
  expect((await initializeDesktopConfig(store, options)).desktop.exitBehavior).toBe('keep_service')
  expect(await readFile(options.configPath, 'utf8')).toBe(before)
  await Promise.all([store.initializeExitBehavior(), store.update({ desktop: { language: 'en-US' } })])
  expect((await new LexoraConfigStore(options).initializeExitBehavior()).desktop.exitBehavior).toBe('keep_service')
  expect(parse(await readFile(options.configPath, 'utf8'))).toMatchObject({ desktop: { exit_behavior: 'keep_service', future: true } })
})
