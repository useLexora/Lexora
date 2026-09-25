import type { ExtensionApi, ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
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

it('publishes installed contributions even while installation jobs are pending or fail', async () => {
  const jobs = deferred<ExtensionInstallation[]>()
  const scope = effectScope()
  const api: Partial<ExtensionApi> = { list: async () => [extension], installations: () => jobs.promise, onChanged: () => () => {} }
  const state = scope.run(() => useExtensionState(api as ExtensionApi))!
  try {
    const pending = state.refresh()
    await Promise.resolve()
    expect(state.installed.value).toEqual([extension])
    jobs.reject(new Error('EXTENSION_JOBS_UNAVAILABLE'))
    await pending
    expect(state.installed.value).toEqual([extension])
    expect(state.error.value).toBe('EXTENSION_JOBS_UNAVAILABLE')
  }
  finally {
    scope.stop()
  }
})

it('does not let stale or disposed refreshes overwrite current contributions', async () => {
  const delayed = deferred<ExtensionStatus[]>()
  let requests = 0
  const scope = effectScope()
  const api: Partial<ExtensionApi> = { list: () => ++requests === 1 ? delayed.promise : Promise.resolve(requests === 2 ? [extension] : []), installations: async () => [], onChanged: () => () => {} }
  const state = scope.run(() => useExtensionState(api as ExtensionApi))!
  const previous = state.refresh()
  await state.refresh()
  delayed.resolve([])
  await previous
  expect(state.installed.value).toEqual([extension])
  scope.stop()
  await state.refresh()
  expect(state.installed.value).toEqual([extension])
})
