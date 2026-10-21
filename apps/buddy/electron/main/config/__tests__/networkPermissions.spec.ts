import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { parse } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import { DEFAULT_NETWORK_PERMISSIONS, networkPermissionsSchema } from '../../../../shared/permissions/networkPermissions'
import { lexoraConfigPatchSchema } from '../../../shared/desktopApiSchemas'
import { LexoraConfigStore } from '../LexoraConfigStore'

async function createStore(content = '[browser]\nlink_opening="system"\nfuture=true\n') {
  const directory = await createTemporaryDirectory('lexora-network-config-')
  const configPath = join(directory, 'config.toml')
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, content)
  return { configPath, store: new LexoraConfigStore({ configPath }) }
}

describe('network permissions persistence', () => {
  it('reads legacy config, roundtrips normalized rules and preserves unrelated browser fields', async () => {
    const { store, configPath } = await createStore()
    expect((await store.read()).browser.networkPermissions).toEqual(DEFAULT_NETWORK_PERMISSIONS)
    const settings = networkPermissionsSchema.parse({
      defaults: { access: 'allow', download: 'ask', upload: 'deny' },
      rules: [{ id: 'site', pattern: 'EXAMPLE.COM.', match: 'exact', access: 'deny', download: 'allow', upload: 'ask' }],
    })
    await store.update({ browser: { networkPermissions: settings } })
    const browserPatch = lexoraConfigPatchSchema.parse({ browser: { freezeDelaySeconds: 120 } })
    expect(browserPatch).toEqual({ browser: { freezeDelaySeconds: 120 } })
    await store.update(browserPatch)
    const reopened = await new LexoraConfigStore({ configPath }).read()
    expect(reopened.browser).toMatchObject({ networkPermissions: settings, freezeDelaySeconds: 120, linkOpening: 'system' })
    expect(parse(await readFile(configPath, 'utf8'))).toMatchObject({ browser: { future: true, network_permissions: settings } })
    await store.update({ browser: { networkPermissions: DEFAULT_NETWORK_PERMISSIONS } })
    expect((await store.read()).browser.networkPermissions.rules).toEqual([])
  })

  it('rejects malformed policies without replacing the original file', async () => {
    const { store, configPath } = await createStore()
    const original = await readFile(configPath, 'utf8')
    await expect(store.update({ browser: { networkPermissions: { ...DEFAULT_NETWORK_PERMISSIONS, rules: [{ id: 'bad', pattern: '(a)\\1', match: 'regex', access: 'allow', download: 'ask', upload: 'ask' }] } } })).rejects.toThrow()
    expect(await readFile(configPath, 'utf8')).toBe(original)
    await writeFile(configPath, '[browser.network_permissions]\nrules=[]\n[browser.network_permissions.defaults]\naccess="inherit"\ndownload="ask"\nupload="ask"\n')
    await expect(store.read()).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  })

  it('serializes narrow approvals against the latest committed rules and checks stale callers', async () => {
    const { store, configPath } = await createStore()
    const check = () => {}
    await Promise.all([
      store.allowNetworkPermission('one.example', 'access', check),
      store.allowNetworkPermission('two.example', 'download', check),
      store.allowNetworkPermission('ONE.EXAMPLE.', 'upload', check),
      store.update({ browser: { defaultZoomFactor: 1.5 } }),
    ])
    const config = await store.read()
    expect(config.browser.networkPermissions.rules).toEqual([
      expect.objectContaining({ pattern: 'one.example', access: 'allow', download: 'ask', upload: 'allow' }),
      expect.objectContaining({ pattern: 'two.example', access: 'ask', download: 'allow', upload: 'ask' }),
    ])
    expect(config.browser.defaultZoomFactor).toBe(1.5)
    const content = await readFile(configPath, 'utf8')
    await expect(store.allowNetworkPermission('stale.example', 'access', () => {
      throw new Error('STALE')
    })).rejects.toThrow('STALE')
    expect(await readFile(configPath, 'utf8')).toBe(content)
  })
})
