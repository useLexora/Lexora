import type { ShellCandidate } from '../../../shared/shell/shellProgram'
import type { JsonValue } from '../../../shared/workbench/workbenchState'
import type { ExtensionServicePorts } from '../ExtensionService'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { extensionManagementSchema } from '../../../shared/extensions/extensionApi'
import { addedExtensionPermissions, extensionManifestSchema } from '../../../shared/extensions/extensionManifest'
import * as programs from '../../process/shellPrograms'
import { ExtensionPackageStore } from '../ExtensionPackageStore'
import { ExtensionService } from '../ExtensionService'
import { reviewPackage } from './fixtures'

const id = 'tests.shells'
const candidates: ShellCandidate[] = [
  { id: 'bash', label: 'Bash', dialect: 'bash', executable: '/usr/bin/bash', version: '5.2', available: true },
  { id: 'zsh', label: 'Zsh', dialect: 'zsh', executable: '', version: '', available: false, reason: 'No usable local installation was found' },
]
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse())
    await action()
  vi.restoreAllMocks()
})
function definition() {
  return extensionManifestSchema.parse({
    schemaVersion: 1,
    id,
    name: 'Shells',
    version: '1.0.0',
    apiVersion: 4,
    engines: { lexora: '>=0.14.0 <1.0.0' },
    entry: 'extension.js',
    permissions: { shells: true },
    contributes: {
      commands: [{ id: `${id}.open`, title: 'Detect' }],
      shells: { candidates: ['bash', 'zsh'].map(key => ({ id: key, enabled: `${key}Enabled`, executable: `${key}Executable`, priority: `${key}Priority` })) },
      settings: {
        modules: [{ id: `${id}.execution`, title: 'Execution' }],
        groups: [{ id: `${id}.group`, module: `${id}.execution`, title: 'Shells' }],
        items: ['bash', 'zsh'].flatMap(key => [
          { id: `${id}.${key}.enabled`, key: `${key}Enabled`, group: `${id}.group`, title: 'Enabled', type: 'boolean', default: false },
          { id: `${id}.${key}.path`, key: `${key}Executable`, group: `${id}.group`, title: 'Path', type: 'string', default: '' },
          { id: `${id}.${key}.priority`, key: `${key}Priority`, group: `${id}.group`, title: 'Priority', type: 'number', default: 0, min: 0, max: 100 },
        ]),
      },
    },
  })
}

async function fixture(ports: Partial<ExtensionServicePorts> = {}, manifest = definition()) {
  const root = await mkdtemp(join(tmpdir(), 'lexora-shell-contract-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store = new ExtensionPackageStore(join(root, 'extensions'), '0.14.0')
  await store.load()
  await store.install((await reviewPackage(root, store, manifest)).token)
  let broker!: (method: string, params: unknown) => Promise<JsonValue>
  let changes = 0
  const service = new ExtensionService(store, {
    createHost: (_pkg, request) => {
      broker = request
      return { call: async () => null, dispose: async () => {}, devtools: () => {} }
    },
    createView: () => { throw new Error('No view expected') },
    workbench: async () => null,
    readText: async () => '',
    get: async () => new Response(''),
    shellsChanged: () => { changes++ },
    ...ports,
  })
  cleanup.push(() => service.dispose())
  return { root, store, service, broker: (method: string, params: unknown) => broker(method, params), changes: () => changes }
}

it('binds the native shell table only to owned groups containing every candidate setting', () => {
  const manifest = definition()
  const grouped = { ...manifest, contributes: { ...manifest.contributes, shells: { ...manifest.contributes.shells!, settingsGroup: `${id}.group` } } }
  expect(extensionManifestSchema.parse(grouped).apiVersion).toBe(4)
  for (const settingsGroup of ['settings.runtime', `${id}.missing`, 'other.plugin.group']) {
    expect(extensionManifestSchema.safeParse({ ...grouped, contributes: { ...grouped.contributes, shells: { ...grouped.contributes.shells, settingsGroup } } }).success).toBe(false)
  }
  for (const key of ['bashEnabled', 'bashExecutable', 'bashPriority']) {
    const settings = grouped.contributes.settings
    expect(extensionManifestSchema.safeParse({ ...grouped, contributes: { ...grouped.contributes, settings: {
      ...settings,
      groups: [...settings.groups, { id: `${id}.other`, module: 'settings.runtime', title: 'Other' }],
      items: settings.items.map(item => item.key === key ? { ...item, group: `${id}.other` } : item),
    } } }).success).toBe(false)
  }
})

it('accepts only declared native management request shapes without paths or probe parameters', () => {
  expect(extensionManagementSchema.parse({ action: 'detectShells', id })).toEqual({ action: 'detectShells', id })
  expect(extensionManagementSchema.parse({ action: 'selectShellExecutable', id, candidate: 'bash' })).toEqual({ action: 'selectShellExecutable', id, candidate: 'bash' })
  for (const input of [
    { action: 'detectShells', id, configured: { bash: '/tmp/program' } },
    { action: 'selectShellExecutable', id, candidate: 'arbitrary' },
    { action: 'selectShellExecutable', id, candidate: 'bash', path: '/tmp/program' },
    { action: 'selectShellExecutable', id, candidate: 'bash', command: '--version' },
  ]) {
    expect(extensionManagementSchema.safeParse(input).success).toBe(false)
  }
})

it('detects all candidates natively without activating a plugin entry and returns independent snapshots', async () => {
  vi.spyOn(programs, 'detectShellPrograms').mockResolvedValue(candidates)
  const manifest = definition()
  delete manifest.entry
  manifest.contributes.commands = []
  const { service } = await fixture({ createHost: () => {
    throw new Error('Unexpected plugin activation')
  } }, manifest)
  const result = await service.detectShells(id)
  expect(result).toEqual(candidates)
  result[0]!.executable = '/tmp/replaced'
  expect(await service.detectShells(id)).toEqual(candidates)
})

it('selects or cancels without probing, writing configuration or granting file access', async () => {
  vi.spyOn(programs, 'detectShellPrograms').mockImplementation(() => {
    throw new Error('Unexpected probe')
  })
  let selected: string | null = '/opt/trusted/bash'
  const { service, store, broker } = await fixture({ selectShellExecutable: async () => selected })
  await service.initialize()
  const before = await service.configuration(id)
  const grants = await store.resources.list(id)
  expect(await service.selectShellExecutable(id, 'bash')).toBe(selected)
  selected = null
  expect(await service.selectShellExecutable(id, 'bash')).toBeNull()
  expect(await service.configuration(id)).toEqual(before)
  expect(await store.resources.list(id)).toEqual(grants)
  await service.execute(id, `${id}.open`, null)
  await expect(broker('shells.selectExecutable', { candidate: 'bash' })).rejects.toThrow('EXTENSION_METHOD_DENIED')
})

it('rejects disabled, uninstalled, unpermitted and undeclared shell selections before opening a picker', async () => {
  const { service, store, root } = await fixture({ selectShellExecutable: async () => {
    throw new Error('Unexpected picker')
  } })
  await expect(service.selectShellExecutable(id, 'cmd')).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
  await service.enable(id, false)
  await expect(service.selectShellExecutable(id, 'bash')).rejects.toThrow('EXTENSION_DEPENDENCY_UNAVAILABLE')
  await expect(service.detectShells(id)).rejects.toThrow('EXTENSION_DEPENDENCY_UNAVAILABLE')
  await service.uninstall(id)
  await expect(service.selectShellExecutable(id, 'bash')).rejects.toThrow('EXTENSION_DEPENDENCY_UNAVAILABLE')
  const manifest = definition()
  delete manifest.contributes.shells
  manifest.permissions.shells = false
  await service.install((await reviewPackage(root, store, manifest)).token)
  await expect(service.selectShellExecutable(id, 'bash')).rejects.toThrow('EXTENSION_PERMISSION_DENIED')
  await expect(service.detectShells(id)).rejects.toThrow('EXTENSION_PERMISSION_DENIED')
})

it.each(['disable', 'revoke', 'configure', 'replace', 'reset'] as const)('rejects a selected path after %s while the dialog is open', async (change) => {
  let complete!: (value: string | null) => void
  const { service, root, store } = await fixture({
    selectShellExecutable: () => new Promise((resolve) => { complete = resolve }),
  })
  const selected = service.selectShellExecutable(id, 'bash')
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
  if (change === 'disable') {
    await service.enable(id, false)
    await service.enable(id, true)
  }
  else if (change === 'revoke') {
    await service.revokeResources(id)
  }
  else if (change === 'configure') {
    await service.configure(id, { bashExecutable: '/opt/new/bash' })
  }
  else if (change === 'replace') {
    await service.install((await reviewPackage(root, store, extensionManifestSchema.parse({ ...definition(), version: '1.1.0' }))).token)
    await service.applyUpdate(id)
  }
  else {
    await service.resetHosts()
  }
  complete('/opt/old/bash')
  await expect(selected).rejects.toThrow(change === 'configure' ? 'EXTENSION_CONFIGURATION_UPDATE_STALE' : 'EXTENSION_HOST_STOPPED')
  expect((await service.configuration(id)).bashExecutable).toBe(change === 'configure' ? '/opt/new/bash' : '')
})

it.each(['revoke', 'configure'] as const)('rejects native detection invalidated by %s', async (change) => {
  let complete!: (value: ShellCandidate[]) => void
  vi.spyOn(programs, 'detectShellPrograms').mockImplementation(() => new Promise((resolve) => {
    complete = resolve
  }))
  const { service } = await fixture()
  const pending = service.detectShells(id)
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
  if (change === 'revoke')
    await service.revokeResources(id)
  else
    await service.configure(id, { bashExecutable: '/opt/new/bash' })
  complete(candidates)
  await expect(pending).rejects.toThrow()
})

it('does not probe an obsolete configuration returned after a concurrent save', async () => {
  const { service, store } = await fixture()
  await service.initialize()
  const previous = await store.configuration(id)
  let complete!: () => void
  vi.spyOn(store, 'configuration').mockImplementationOnce(() => new Promise((resolve) => {
    complete = () => resolve(previous)
  }))
  vi.spyOn(programs, 'detectShellPrograms').mockImplementation(() => {
    throw new Error('Unexpected stale probe')
  })
  const pending = service.detectShells(id)
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
  await service.configure(id, { bashExecutable: '/opt/new/bash' })
  complete()
  await expect(pending).rejects.toThrow('EXTENSION_CONFIGURATION_UPDATE_STALE')
  expect((await service.configuration(id)).bashExecutable).toBe('/opt/new/bash')
})

it('requires a separate reviewed API 4 permission and safe native setting defaults', () => {
  const manifest = definition()
  expect(addedExtensionPermissions(undefined, manifest.permissions)).toEqual(['shells'])
  expect(extensionManifestSchema.safeParse({ ...manifest, apiVersion: 3 }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...manifest, permissions: {} }).success).toBe(false)
  for (const patch of [{ id: 'arbitrary' }, { command: 'echo unsafe' }, { executable: '/tmp/program' }, { enabled: 'bashExecutable' }]) {
    const value = { ...manifest, contributes: { ...manifest.contributes, shells: { candidates: [{ ...manifest.contributes.shells!.candidates[0], ...patch }] } } }
    expect(extensionManifestSchema.safeParse(value).success).toBe(false)
  }
  for (const type of ['boolean', 'string', 'number']) {
    const items = manifest.contributes.settings.items.map(item => item.type === type ? { ...item, default: type === 'boolean' ? true : type === 'string' ? '/tmp/program' : 1 } : item)
    expect(extensionManifestSchema.safeParse({ ...manifest, contributes: { ...manifest.contributes, settings: { ...manifest.contributes.settings, items } } }).success).toBe(false)
  }
})

it('keeps platform defaults, filters enabled candidates, retains unavailable reasons and uses only native configuration', async () => {
  vi.spyOn(programs, 'detectShellPrograms').mockImplementation(async ({ configured } = {}) => candidates.map(candidate => ({ ...candidate, executable: configured?.[candidate.id] ?? candidate.executable })))
  const { service, broker, changes } = await fixture()
  expect(await service.shellContributions()).toEqual([expect.objectContaining({ extensionId: id, candidates: [], preferred: [] })])
  expect(changes()).toBe(0)
  await service.execute(id, `${id}.open`, null)
  expect(await broker('shells.detect', null)).toEqual(candidates)
  await expect(broker('shells.detect', { configured: { bash: '/tmp/program' } })).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
  await expect(broker('configuration.set', { bashExecutable: '/tmp/program' })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await expect(broker('shell.execute', { command: 'echo unsafe' })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await broker('storage.set', { value: { bashExecutable: '/tmp/program' }, version: 1 })
  expect((await service.configuration(id)).bashExecutable).toBe('')
  await service.configure(id, { bashEnabled: true, zshEnabled: true, bashExecutable: '/opt/trusted/bash', bashPriority: 2, zshPriority: 1 })
  const descriptors = await service.shellContributions()
  expect(descriptors).toEqual([expect.objectContaining({
    candidates: [{ ...candidates[0], executable: '/opt/trusted/bash' }, candidates[1]],
    preferred: ['zsh', 'bash'],
  })])
  expect(changes()).toBe(1)
  await service.configure(id, { bashPriority: 2 })
  expect(changes()).toBe(1)
})

it('withdraws disabled, uninstalled and replaced packages while preserving user settings', async () => {
  vi.spyOn(programs, 'detectShellPrograms').mockResolvedValue(candidates)
  const { root, store, service } = await fixture()
  await service.configure(id, { bashEnabled: true, bashPriority: 1 })
  const initial = (await service.shellContributions())[0]!
  await service.enable(id, false)
  expect(await service.shellContributions()).toEqual([])
  await service.enable(id, true)
  expect(await service.shellContributions()).toEqual([initial])
  const updated = extensionManifestSchema.parse({ ...definition(), version: '1.1.0' })
  await service.install((await reviewPackage(root, store, updated)).token)
  expect(await service.shellContributions()).toEqual([initial])
  await service.applyUpdate(id)
  const next = (await service.shellContributions())[0]!
  expect(next.revision).not.toBe(initial.revision)
  expect(next.candidates).toEqual(initial.candidates)
  expect(next.configurationRevision).toBe(initial.configurationRevision)
  await service.uninstall(id)
  expect(await service.shellContributions()).toEqual([])
  await service.install((await reviewPackage(root, store, updated)).token)
  expect((await service.shellContributions())[0]!.preferred).toEqual(['bash'])
})

it('reuses configuration fingerprints but refreshes detection from the read-only UI', async () => {
  let output = candidates
  vi.spyOn(programs, 'detectShellPrograms').mockImplementation(async () => output)
  const { service, broker, changes } = await fixture()
  await service.configure(id, { bashEnabled: true })
  await service.execute(id, `${id}.open`, null)
  expect((await service.shellContributions())[0]!.candidates[0]!.version).toBe('5.2')
  output = [{ ...candidates[0]!, version: '5.3' }, candidates[1]!]
  expect((await service.shellContributions())[0]!.candidates[0]!.version).toBe('5.2')
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 1100)
  expect(await broker('shells.detect', null)).toEqual(output)
  expect((await service.shellContributions())[0]!.candidates[0]!.version).toBe('5.3')
  expect(changes()).toBe(2)
})

it('rejects stale detection when disabled before a pending probe completes', async () => {
  let complete!: (value: ShellCandidate[]) => void
  vi.spyOn(programs, 'detectShellPrograms').mockImplementation(() => new Promise((resolve) => {
    complete = resolve
  }))
  const { service } = await fixture()
  await service.configure(id, { bashEnabled: true })
  const pending = service.shellContributions()
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
  await service.enable(id, false)
  complete(candidates)
  expect(await pending).toEqual([])
})
