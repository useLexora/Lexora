import { resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { checkSandboxEnvironment } from '../sandboxDependencies'

describe('sandbox environment status', () => {
  it.skipIf(process.platform !== 'linux')('checks the packaged components and a real read-only namespace probe', async () => {
    await expect(checkSandboxEnvironment({
      sandboxDirectory: resolve(`.output/build/shell-sandbox/linux-${process.arch}`),
      searchDirectory: resolve(`.output/build/search-tools/linux-${process.arch}`),
    })).resolves.toBe('available')
  })

  it('does not report protection when sandbox components are missing', async () => {
    await expect(checkSandboxEnvironment({
      sandboxDirectory: resolve('.output/missing-sandbox-components'),
      searchDirectory: resolve('.output/missing-search-components'),
    })).resolves.toBe('unavailable')
  })
})
