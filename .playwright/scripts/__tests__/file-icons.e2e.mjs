import { test } from '../fixtures/electron.mjs'
import { exerciseFileIconPlugin, writeFileIconPlugin } from './fileIconPlugin.mjs'

test('file icon plugin renders variants, survives restart and falls back after uninstall', async ({ buddy }, testInfo) => {
  const plugin = await writeFileIconPlugin(testInfo.outputPath('icon-plugin'))
  await exerciseFileIconPlugin(buddy, testInfo, plugin)
})
