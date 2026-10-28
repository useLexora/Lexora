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
const job: ExtensionInstallation = { id: 'job', name: 'Panel', extensionId: extension.manifest.id, version: '1.0.0', startedAt: '2026-01-01T00:00:00.000Z', status: 'running', stage: 'compile', entries: [], error: null }

function setup(overrides: Partial<ExtensionApi> = {}) {
  let statusChanged = () => {}
  let progressChanged = () => {}
  const api: Partial<ExtensionApi> = {
    list: async () => [extension],
    unavailable: async () => [],
    installations: async () => [],
    taskActions: async () => [],
    onChanged: (listener) => {
      statusChanged = listener
      return () => {}
    },
    onInstallationsChanged: (listener) => {
      progressChanged = listener
      return () => {}
    },
    ...overrides,
  }
  const scope = effectScope()
  const state = scope.run(() => useExtensionState(api as ExtensionApi))!
  return { state, scope, statusChanged: () => statusChanged(), progressChanged: () => progressChanged() }
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

it('coalesces overlapping refreshes and rejects stale and disposed results', async () => {
  const delayed = deferred<ExtensionStatus[]>()
  let requests = 0
  const { state, scope } = setup({ list: () => ++requests === 1 ? delayed.promise : Promise.resolve([extension]) })
  try {
    const previous = state.refresh()
    await expect.poll(() => requests).toBe(1)
    const refreshes = Array.from({ length: 20 }, () => state.refresh())
    expect(requests).toBe(1)
    delayed.resolve([])
    await Promise.all([previous, ...refreshes])
    expect(state.installed.value).toEqual([extension])
    expect(requests).toBe(2)
    scope.stop()
    await state.refresh()
    expect(state.installed.value).toEqual([extension])
    expect(requests).toBe(2)
  }
  finally { scope.stop() }
})

it('updates progress without replacing installed contributions or requesting their data', async () => {
  let listRequests = 0
  let jobs = [job]
  const { state, scope, progressChanged } = setup({
    list: async () => {
      listRequests++
      return [extension]
    },
    installations: async () => jobs,
  })
  try {
    await state.refresh()
    const original = state.installed.value
    jobs = [{ ...job, stage: 'install' }]
    progressChanged()
    await expect.poll(() => state.installations.value[0]?.stage).toBe('install')
    expect(state.installed.value).toBe(original)
    expect(listRequests).toBe(1)
  }
  finally { scope.stop() }
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
