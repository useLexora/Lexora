import type { ExtensionApi, ExtensionReview, ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionInstallation } from '@buddy-shared/extensions/extensionInstallation'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { deferred } from '@buddy-tests/deferred'
import { expect, it } from 'vitest'
import { effectScope } from 'vue'
import { useExtensionState } from '../useExtensionState'

const extension: ExtensionStatus = {
  manifest: extensionManifestSchema.parse({ schemaVersion: 1, id: 'test.panel', name: 'Panel', version: '1.0.0', apiVersion: 1, engines: { lexora: '*' }, contributes: {} }),
  revision: 'revision',
  enabled: true,
  compatible: true,
  development: false,
  pending: null,
  state: 'inactive',
  generation: null,
  error: null,
  activationMs: null,
  logs: [],
}
const review: ExtensionReview = { manifest: extension.manifest, token: 'review', installationId: 'job', sha256: 'hash', development: false, currentVersion: null, addedPermissions: [] }

function setup(overrides: Partial<ExtensionApi> = {}) {
  let statusChanged = () => {}
  const api: Partial<ExtensionApi> = {
    list: async () => [extension],
    unavailable: async () => [],
    installations: async () => [],
    taskActions: async () => [],
    onChanged: (listener) => {
      statusChanged = listener
      return () => {}
    },
    onInstallationsChanged: () => () => {},
    ...overrides,
  }
  const scope = effectScope()
  const state = scope.run(() => useExtensionState(api as ExtensionApi))!
  return { state, scope, statusChanged: () => statusChanged() }
}

it('publishes installed contributions while installation jobs are pending or fail', async () => {
  const jobs = deferred<ExtensionInstallation[]>()
  const { state, scope } = setup({ installations: () => jobs.promise })
  try {
    const pending = state.refresh()
    await expect.poll(() => state.installed.value).toEqual([extension])
    jobs.reject(new Error('EXTENSION_JOBS_UNAVAILABLE'))
    await pending
    expect(state.installed.value).toEqual([extension])
    expect(state.error.value).toBe('EXTENSION_JOBS_UNAVAILABLE')
  }
  finally { scope.stop() }
})

it('publishes serial snapshots during a change burst and ignores reads after disposal', async () => {
  const first = deferred<ExtensionStatus[]>()
  const second = deferred<ExtensionStatus[]>()
  const third = deferred<ExtensionStatus[]>()
  const reads = [first, second, third]
  let requests = 0
  const { state, scope, statusChanged } = setup({ list: () => reads[requests++]!.promise })
  try {
    const pending = state.refresh()
    await expect.poll(() => requests).toBe(1)
    statusChanged()
    first.resolve([{ ...extension, revision: 'progress-1' }])
    await expect.poll(() => requests).toBe(2)
    expect(state.installed.value[0]?.revision).toBe('progress-1')
    statusChanged()
    second.resolve([{ ...extension, revision: 'progress-2' }])
    await expect.poll(() => requests).toBe(3)
    expect(state.installed.value[0]?.revision).toBe('progress-2')
    scope.stop()
    third.resolve([{ ...extension, revision: 'disposed' }])
    await pending
    expect(state.installed.value[0]?.revision).toBe('progress-2')
  }
  finally { scope.stop() }
})

it('deduplicates only the running menu action while allowing other plugin interactions', async () => {
  const pending = deferred<null>()
  const { state, scope } = setup({ executeMenu: async (_id, menu) => menu === 'work' ? pending.promise : null })
  try {
    const work = state.executeAction('test.panel', 'work')
    expect(state.pendingActions.get('test.panel')).toEqual(['work'])
    expect(await state.executeAction('test.panel', 'work')).toBe(false)
    expect(await state.executeAction('test.panel', 'show-result')).toBe(true)
    expect(state.pendingActions.get('test.panel')).toEqual(['work'])
    expect(state.busyIds.has('test.panel')).toBe(false)
    pending.resolve(null)
    expect(await work).toBe(true)
    expect(state.pendingActions.size).toBe(0)
  }
  finally {
    pending.resolve(null)
    scope.stop()
  }
})

it('keeps new installs separate from usable plugins and only locks the matching plugin', async () => {
  const installing = deferred<void>()
  let installed: ExtensionStatus[] = []
  const { state, scope } = setup({ list: async () => installed, install: () => installing.promise })
  try {
    const pending = state.install(review, false)
    expect(state.pendingInstalls.get(extension.manifest.id)?.manifest.name).toBe('Panel')
    expect(state.installed.value).toEqual([])
    expect(state.busyIds.has(extension.manifest.id)).toBe(true)
    let duplicate = false
    expect(await state.runOperation(extension.manifest.id, async () => {
      duplicate = true
    })).toBe(false)
    expect(duplicate).toBe(false)
    let other = false
    await state.runOperation('other.plugin', async () => {
      other = true
    })
    expect(other).toBe(true)
    expect(state.busyIds.has(extension.manifest.id)).toBe(true)
    installed = [extension]
    installing.resolve()
    await pending
    expect(state.installed.value).toEqual([extension])
    expect(state.pendingInstalls.size).toBe(0)
    expect(state.busyIds.size).toBe(0)
  }
  finally {
    installing.resolve()
    scope.stop()
  }
})

it('retains a failed installation on its card without registering a plugin or leaving a lock', async () => {
  const { state, scope } = setup({
    list: async () => [],
    install: async () => {
      throw new Error('EXTENSION_INVALID_ARCHIVE')
    },
  })
  try {
    await expect(state.install(review, false)).rejects.toThrow('EXTENSION_INVALID_ARCHIVE')
    expect(state.installed.value).toEqual([])
    expect(state.pendingInstalls.get(extension.manifest.id)?.error).toBe('EXTENSION_INVALID_ARCHIVE')
    expect(state.busyIds.size).toBe(0)
    state.dismissInstall(extension.manifest.id)
    expect(state.pendingInstalls.size).toBe(0)
  }
  finally { scope.stop() }
})

it('keeps an update busy through version switching and preserves the original plugin on failure', async () => {
  const switching = deferred<void>()
  const { state, scope } = setup({ install: async () => {}, applyUpdate: () => switching.promise })
  try {
    await state.refresh()
    const pending = state.install({ ...review, currentVersion: '0.9.0' }, true)
    const rejected = expect(pending).rejects.toThrow('EXTENSION_UPDATE_FAILED')
    await expect.poll(() => state.pendingInstalls.get(extension.manifest.id)?.phase).toBe('apply-update')
    expect(state.busyIds.has(extension.manifest.id)).toBe(true)
    expect(state.installed.value).toEqual([extension])
    switching.reject(new Error('EXTENSION_UPDATE_FAILED'))
    await rejected
    expect(state.installed.value).toEqual([extension])
    expect(state.pendingInstalls.get(extension.manifest.id)?.error).toBe('EXTENSION_UPDATE_FAILED')
    expect(state.busyIds.size).toBe(0)
  }
  finally {
    switching.resolve()
    scope.stop()
  }
})
