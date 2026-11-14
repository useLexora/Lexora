import type { ExtensionManifest } from '../../../shared/extensions/extensionManifest'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { extensionManifestSchema } from '../../../shared/extensions/extensionManifest'
import { extensionActivationOrder } from '../ExtensionPackageStore'
import { createStore, manifest, reviewPackage } from './fixtures'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const value = await createStore()
  roots.push(value.root)
  return value
}
function service(id: string, dependencies: Record<string, string> = {}, version = '1.0.0'): ExtensionManifest {
  return manifest({ id, apiVersion: 5, executionScope: 'service', version, dependencies, permissions: {}, contributes: {} })
}

describe('explicit extension execution lifetime', () => {
  it('keeps pre-service APIs confined to desktop execution', () => {
    const input = manifest({ apiVersion: 4 })
    expect(extensionManifestSchema.parse(input).executionScope).toBe('desktop')
    expect(extensionManifestSchema.safeParse({ ...input, executionScope: 'service' }).success).toBe(false)
  })

  it('requires an explicit API 5 backend without unknown permissions or autonomous schedules', () => {
    const input = service('tests.background')
    expect(extensionManifestSchema.safeParse({ ...input, entry: undefined }).success).toBe(false)
    expect(extensionManifestSchema.safeParse({ ...input, permissions: { schedules: true } }).success).toBe(false)
    expect(extensionManifestSchema.safeParse({ ...input, permissions: { backgroundNetwork: true } }).success).toBe(false)
    expect(extensionManifestSchema.safeParse({ ...input, executionScope: 'unbounded' }).success).toBe(false)
    expect(extensionManifestSchema.parse({ ...input, executionScope: 'desktop', permissions: { schedules: true } }).executionScope).toBe('desktop')
  })

  it('reviews the complete service dependency graph and preserves a dependency when a scope downgrade is rejected', async () => {
    const { root, store } = await fixture()
    const leaf = service('tests.leaf')
    const middle = service('tests.middle', { [leaf.id]: '^1.0.0' })
    const backend = service('tests.background', { [middle.id]: '^1.0.0' })
    await expect(reviewPackage(root, store, backend)).rejects.toThrow('EXTENSION_DEPENDENCY_VERSION')
    for (const item of [leaf, middle, backend])
      await store.install((await reviewPackage(root, store, item)).token)
    expect(extensionActivationOrder(store.installed, backend.id)).toEqual([leaf.id, middle.id, backend.id])
    const prior = store.installed[leaf.id]!.current
    await expect(reviewPackage(root, store, manifest({ ...leaf, version: '1.1.0', executionScope: 'desktop' }))).rejects.toThrow('EXTENSION_DEPENDENCY_EXECUTION_SCOPE')
    expect(store.installed[leaf.id]!.current).toEqual(prior)
    expect(store.installed[leaf.id]!.pending).toBeNull()
    await store.enable(leaf.id, false)
    expect(() => extensionActivationOrder(store.installed, backend.id)).toThrow('EXTENSION_DEPENDENCY_UNAVAILABLE')
  })

  it('pins reviewed dependency revisions until installation commits', async () => {
    const { root, store } = await fixture()
    const dependency = service('tests.dependency')
    await store.install((await reviewPackage(root, store, dependency)).token)
    const backend = service('tests.background', { [dependency.id]: '^1.0.0' })
    const review = await reviewPackage(root, store, backend)
    expect(review.addedPermissions).toContain('executionScope:service')
    await store.install((await reviewPackage(root, store, service(dependency.id, {}, '1.1.0'))).token)
    await store.promote(dependency.id)
    await expect(store.install(review.token)).rejects.toThrow('EXTENSION_REVIEW_CHANGED')
    expect(store.installed[backend.id]).toBeUndefined()
    expect(store.installed[dependency.id]!.current.manifest.version).toBe('1.1.0')
    await store.install((await reviewPackage(root, store, backend)).token)
    expect(store.installed[backend.id]!.current.manifest.executionScope).toBe('service')
  })

  it('requires review for a desktop to service upgrade and does not change the current package before promotion', async () => {
    const { root, store } = await fixture()
    const desktop = manifest({ id: 'tests.upgrade', permissions: {}, contributes: {} })
    await store.install((await reviewPackage(root, store, desktop)).token)
    const review = await reviewPackage(root, store, service(desktop.id, {}, '1.1.0'))
    expect(review).toMatchObject({ previousExecutionScope: 'desktop', addedPermissions: ['executionScope:service'] })
    await store.install(review.token)
    expect(store.installed[desktop.id]!.current.manifest.executionScope).toBe('desktop')
    expect(store.installed[desktop.id]!.pending!.manifest.executionScope).toBe('service')
    await store.promote(desktop.id)
    expect(store.installed[desktop.id]!.current.manifest.executionScope).toBe('service')
  })
})
