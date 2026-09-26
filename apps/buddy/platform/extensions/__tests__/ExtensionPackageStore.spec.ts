import type { InstalledExtension } from '../ExtensionPackageStore'
import { Buffer } from 'node:buffer'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { extensionJsonSchema } from '../../../shared/extensions/extensionApi'
import { addedExtensionPermissions, extensionManifestSchema } from '../../../shared/extensions/extensionManifest'
import { compileExtensionSource } from '../compileExtensionSource'
import { readExtensionDirectory, unpackExtension } from '../extensionFiles'
import { extensionActivationOrder, ExtensionPackageStore } from '../ExtensionPackageStore'
import { createStore, manifest, reviewPackage } from './fixtures'

const roots: string[] = []
async function fixture() {
  const result = await createStore()
  roots.push(result.root)
  return result
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('extension package contract', () => {
  it('bounds state by UTF-8 bytes and requires permission for declared file views', () => {
    expect(extensionJsonSchema.safeParse('文'.repeat(90000)).success).toBe(false)
    expect(extensionManifestSchema.safeParse({ ...manifest(), permissions: { selectedResource: 'none', network: [] } }).success).toBe(false)
  })
  it.each(['../entry.js', '/entry.js', 'file:entry.js', 'a\\entry.js', 'a/../entry.js', 'con.js', '__host.js'])('rejects unsafe executable path %s', (entry) => {
    expect(extensionManifestSchema.safeParse({ ...manifest(), entry }).success).toBe(false)
  })
  it('rejects foreign contribution ownership, duplicate IDs, and unsupported API versions', () => {
    const value = manifest()
    expect(extensionManifestSchema.safeParse({ ...value, apiVersion: 4 }).success).toBe(false)
    expect(extensionManifestSchema.safeParse({ ...value, contributes: { ...value.contributes, commands: [{ id: 'another.reader.open', title: 'Open' }] } }).success).toBe(false)
    expect(extensionManifestSchema.safeParse({ ...value, contributes: { ...value.contributes, commands: [value.contributes.commands[0], value.contributes.commands[0]] } }).success).toBe(false)
  })
  it.each(['../escaped.js', 'C:/escaped.js', '__view.html'])('rejects archive traversal and reserved assets: %s', (name) => {
    expect(() => unpackExtension(zipSync({ [name]: strToU8('content') }))).toThrow(/EXTENSION_/)
  })
  it('rejects case collisions and compressed files exceeding the expanded limit', () => {
    expect(() => unpackExtension(zipSync({ 'a.js': strToU8('a'), 'A.js': strToU8('b') }))).toThrow(/EXTENSION_/)
    expect(() => unpackExtension(zipSync({ 'large.js': new Uint8Array(4 * 1024 * 1024 + 1) }))).toThrow(/EXTENSION_/)
    expect(() => unpackExtension(new Uint8Array([1, 2, 3]))).toThrow(/EXTENSION_/)
  })
  it('pins reviewed bytes and stages updates without changing the running package', async () => {
    const { root, store } = await fixture()
    const first = await reviewPackage(root, store)
    await store.install(first.token)
    const before = store.installed['tests.reader']!.current
    const update = await reviewPackage(root, store, manifest({ version: '1.1.0', permissions: { selectedResource: 'read', network: ['https://example.com'] } }))
    expect(update.addedPermissions).toEqual(['network:https://example.com'])
    await store.install(update.token)
    expect(store.installed['tests.reader']!.current).toEqual(before)
    expect(store.installed['tests.reader']!.pending?.manifest.version).toBe('1.1.0')
    await store.promote('tests.reader')
    const reloaded = new ExtensionPackageStore(store.root, '0.7.3')
    await reloaded.load()
    expect(reloaded.installed['tests.reader']!.current.manifest.version).toBe('1.1.0')
    expect(reloaded.installed['tests.reader']!.pending).toBeNull()
    await expect(store.install(update.token)).rejects.toThrow('EXTENSION_REVIEW_EXPIRED')
  })
  it('refuses incompatible versions and missing entry modules before installation', async () => {
    const { root, store } = await fixture()
    await expect(reviewPackage(root, store, manifest({ engines: { lexora: '>=1' } }))).rejects.toThrow('EXTENSION_INCOMPATIBLE')
    await expect(reviewPackage(root, store, manifest({ entry: 'missing.js' }))).rejects.toThrow('EXTENSION_ENTRY_MISSING')
    expect(store.installed).toEqual({})
  })
  it('keeps the installed version after compilation failure or cancellation and validates compiled permissions', async () => {
    const { root, store } = await fixture()
    await store.install((await reviewPackage(root, store)).token)
    const installed = structuredClone(store.installed)
    const source = manifest({ version: '1.1.0', format: 'source', entry: 'extension.ts' })
    const failed = await reviewPackage(root, store, source, { 'extension.ts': 'export const value: = 2' })
    const fail = async () => {
      throw new Error('EXTENSION_SOURCE_COMPILE_FAILED')
    }
    await expect(store.prepare(failed.token, fail, new AbortController().signal, () => {})).rejects.toThrow('EXTENSION_SOURCE_COMPILE_FAILED')
    const valid = await reviewPackage(root, store, source, { 'extension.ts': 'export function activate() {}' })
    const controller = new AbortController()
    controller.abort(new Error('EXTENSION_INSTALL_CANCELLED'))
    await expect(store.prepare(valid.token, async files => files, controller.signal, () => {})).rejects.toThrow('EXTENSION_INSTALL_CANCELLED')
    const malicious = await reviewPackage(root, store, source, { 'extension.ts': 'export function activate() {}' })
    await expect(store.prepare(malicious.token, async (files, input) => {
      files.delete('extension.js')
      const compiled = compileExtensionSource(files, input, () => {})
      const changed = JSON.parse(new TextDecoder().decode(compiled.get('extension.json')))
      changed.permissions.notifications = true
      compiled.set('extension.json', strToU8(JSON.stringify(changed)))
      return compiled
    }, new AbortController().signal, () => {})).rejects.toThrow('EXTENSION_COMPILE_OUTPUT_INVALID')
    expect(store.installed).toEqual(installed)
  })
  it('detects installed file tampering and rejects development symlinks', async () => {
    const { root, store } = await fixture()
    await store.install((await reviewPackage(root, store)).token)
    const pkg = store.installed['tests.reader']!.current
    await writeFile(join(store.packageRoot(pkg), 'view.js'), 'changed')
    await expect(store.asset(pkg, 'view.js')).rejects.toThrow('EXTENSION_PACKAGE_CHANGED')
    await symlink(join(store.packageRoot(pkg), 'extension.js'), join(store.packageRoot(pkg), 'linked.js'))
    await expect(readExtensionDirectory(store.packageRoot(pkg))).rejects.toThrow('EXTENSION_UNSAFE_PATH')
  })
  it('uses reviewed package icons and rejects missing, oversized and external icon assets', async () => {
    const { root, store } = await fixture()
    const value = manifest({ icon: 'icon.svg' })
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>'
    const review = await reviewPackage(root, store, value, { 'icon.svg': svg })
    expect(review.iconUrl).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    await store.install(review.token)
    expect(await store.icon(store.installed[value.id]!.current)).toBe(review.iconUrl)
    const next = { ...value, version: '1.1.0' }
    await expect(reviewPackage(root, store, next)).rejects.toThrow('EXTENSION_ICON_INVALID')
    await expect(reviewPackage(root, store, next, { 'icon.svg': 'x'.repeat(65537) })).rejects.toThrow('EXTENSION_ICON_INVALID')
    expect(extensionManifestSchema.safeParse({ ...value, icon: 'https://example.com/icon.svg' }).success).toBe(false)
    expect(store.installed[value.id]!.pending).toBeNull()
  })
  it('preserves corrupt indexes instead of silently resetting installed extensions', async () => {
    const { store } = await fixture()
    const path = join(store.root, 'installed.json')
    await writeFile(path, '{broken')
    await expect(new ExtensionPackageStore(store.root, '0.7.3').load()).rejects.toThrow('EXTENSION_REGISTRY_UNREADABLE')
    expect(await readFile(path, 'utf8')).toBe('{broken')
  })
  it('preserves private data and its previous snapshot; cancelled writes cannot advance the version', async () => {
    const { store } = await fixture()
    await store.saveData('tests.reader', { count: 1 }, 1)
    await store.saveData('tests.reader', { count: 2 }, 2)
    expect(JSON.parse(await readFile(join(store.root, 'data/tests.reader/state.previous.json'), 'utf8'))).toEqual({ version: 1, value: { count: 1 } })
    await expect(store.saveData('tests.reader', { count: 3 }, 3, () => {
      throw new Error('EXTENSION_HOST_STOPPED')
    })).rejects.toThrow('EXTENSION_HOST_STOPPED')
    await store.uninstall('tests.reader')
    expect(await store.data('tests.reader')).toEqual({ version: 2, value: { count: 2 } })
  })
  it('sorts dependencies and rejects cycles, disabled dependencies, and mismatched ranges', () => {
    const a = manifest({ id: 'tests.alpha', dependencies: { 'tests.beta': '^1' } })
    const b = manifest({ id: 'tests.beta' })
    const record = (value: typeof a): InstalledExtension => ({ current: { manifest: value, revision: 'a'.repeat(64), hashes: {}, source: null }, enabled: true, pending: null, development: false })
    const installed = { 'tests.alpha': record(a), 'tests.beta': record(b) }
    expect(extensionActivationOrder(installed, a.id)).toEqual(['tests.beta', 'tests.alpha'])
    installed['tests.beta'].enabled = false
    expect(() => extensionActivationOrder(installed, a.id)).toThrow('EXTENSION_DEPENDENCY_UNAVAILABLE')
    installed['tests.beta'].enabled = true
    b.dependencies = { 'tests.alpha': '*' }
    expect(() => extensionActivationOrder(installed, a.id)).toThrow('EXTENSION_DEPENDENCY_CYCLE')
    b.dependencies = {}
    b.version = '2.0.0'
    expect(() => extensionActivationOrder(installed, a.id)).toThrow('EXTENSION_DEPENDENCY_VERSION')
  })
})

it.each(['composer.input', 'workbench.pane'] as const)('preserves the declared decoration scope and requires permission: %s', (anchor) => {
  const input = manifest({ apiVersion: 2, permissions: { windowEffects: true }, contributes: {
    views: [{ id: 'tests.reader.effect', title: 'Effect', entry: 'view.js', resource: 'none' }],
    placements: [{ id: 'tests.reader.scope', view: 'tests.reader.effect', kind: 'decoration', anchor }],
  } })
  expect(extensionManifestSchema.parse(input).contributes.placements[0]).toEqual({ id: 'tests.reader.scope', view: 'tests.reader.effect', kind: 'decoration', anchor })
  expect(extensionManifestSchema.safeParse({ ...input, permissions: {} }).success).toBe(false)
})

it.each([1, 2] as const)('accepts window overlays in API %s without adding local placements', (apiVersion) => {
  const input = manifest({ apiVersion, permissions: { windowEffects: true }, contributes: {
    views: [{ id: 'tests.reader.effect', title: 'Effect', entry: 'view.js', resource: 'none', location: 'window-overlay' }],
  } })
  expect(extensionManifestSchema.parse(input).contributes.views[0]?.location).toBe('window-overlay')
  expect(extensionManifestSchema.safeParse({ ...input, permissions: {} }).success).toBe(false)
})

it('keeps API 1 compatible and validates UI placements and permission upgrades in API 2', async () => {
  const { root, store } = await fixture()
  const old = manifest()
  await store.install((await reviewPackage(root, store, old)).token)
  const value = manifest({
    apiVersion: 2,
    version: '1.1.0',
    permissions: { windowEffects: true, controls: ['model.reasoning'] },
    contributes: {
      views: [{ id: 'tests.reader.ui', title: 'UI', entry: 'view.js', resource: 'none' }],
      navigation: { view: 'tests.reader.ui', title: 'Reader' },
      placements: [
        { id: 'tests.reader.top', view: 'tests.reader.ui', kind: 'view', location: 'workbench.top' },
        { id: 'tests.reader.effect', view: 'tests.reader.ui', kind: 'decoration', anchor: 'composer.input' },
        { id: 'tests.reader.reasoning', view: 'tests.reader.ui', kind: 'control', target: 'model.reasoning' },
      ],
    },
  })
  const review = await reviewPackage(root, store, value)
  expect(review.addedPermissions).toEqual(['windowEffects', 'controls:model.reasoning'])
  expect(extensionManifestSchema.safeParse({ ...value, apiVersion: 1 }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...value, contributes: { ...value.contributes, placements: [], views: [{ ...value.contributes.views[0], location: 'window-overlay' }] } }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...value, permissions: { windowEffects: true } }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...value, permissions: { controls: ['model.reasoning'] } }).success).toBe(false)
  for (const placement of [
    { ...value.contributes.placements[0], view: 'tests.reader.missing' },
    { ...value.contributes.placements[0], id: 'other.plugin.top' },
    { ...value.contributes.placements[0], location: 'arbitrary.selector' },
    { ...value.contributes.placements[0], height: 9000 },
    { ...value.contributes.placements[1], anchor: 'document.body' },
    { ...value.contributes.placements[2], target: 'permissions.approval' },
  ]) {
    expect(extensionManifestSchema.safeParse({ ...value, contributes: { ...value.contributes, placements: [placement] } }).success).toBe(false)
  }
  expect(extensionManifestSchema.safeParse({ ...value, contributes: { ...value.contributes, views: [{ ...value.contributes.views[0], resource: 'selected-file' }] }, permissions: { ...value.permissions, selectedResource: 'read' } }).success).toBe(false)
})

it('requires API 3 and a bounded declaration for a content slot', () => {
  const value = manifest({
    apiVersion: 3,
    id: 'tests.footer',
    contributes: {
      views: [{ id: 'tests.footer.content', title: 'Footer', entry: 'view.js', resource: 'none' }],
      placements: [{ id: 'tests.footer.slot', kind: 'slot', target: 'composer.footer', view: 'tests.footer.content' }],
    },
  })
  const previous = manifest({ id: 'tests.footer', apiVersion: 2, contributes: { views: [] } })
  expect(addedExtensionPermissions(previous.permissions, value.permissions)).toEqual([])
  expect(extensionManifestSchema.safeParse({ ...value, apiVersion: 2 }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...value, contributes: { ...value.contributes, placements: [{ ...value.contributes.placements[0], presentation: { position: 'absolute' } }] } }).success).toBe(false)
})

it('validates each content target size and menu command ownership with API compatibility', () => {
  const content = (target: string, height: number) => ({ id: 'tests.reader.content', kind: 'slot', target, height, view: 'tests.reader.view' })
  const base = { schemaVersion: 1, id: 'tests.reader', name: 'Regions', version: '1.0.0', apiVersion: 3, engines: { lexora: '*' }, entry: 'extension.js', contributes: { commands: [{ id: 'tests.reader.run', title: 'Run' }], views: [{ id: 'tests.reader.view', title: 'View', entry: 'view.js', resource: 'none' }] } }
  const parse = (placement: unknown) => extensionManifestSchema.safeParse({ ...base, contributes: { ...base.contributes, placements: [placement] } })
  expect(parse(content('composer.footer', 64)).success).toBe(false)
  expect(parse(content('composer.accessory', 64)).success).toBe(true)
  expect(parse(content('task.welcome', 400)).success).toBe(true)
  expect(parse(content('workbench.pane.empty', 641)).success).toBe(false)
  expect(parse(content('arbitrary.selector', 64)).success).toBe(false)
  const withMenu = { ...base, contributes: { ...base.contributes, menus: [{ id: 'tests.reader.menu', command: 'tests.reader.run', target: 'message.actions' }] } }
  expect(extensionManifestSchema.safeParse(withMenu).success).toBe(true)
  expect(extensionManifestSchema.safeParse({ ...withMenu, apiVersion: 2 }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...withMenu, contributes: { ...withMenu.contributes, commands: [] } }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...base, apiVersion: 2, permissions: { selectedContent: true } }).success).toBe(false)
  const previous = manifest()
  const next = manifest({ apiVersion: 3, permissions: { selectedResource: 'read', selectedContent: true } })
  expect(addedExtensionPermissions(previous.permissions, next.permissions)).toEqual(['selectedContent'])
})

it('validates ASCII command names while allowing localized descriptions and system names inside plugin namespaces', () => {
  const base = manifest({ apiVersion: 3, contributes: { commands: [{ id: 'tests.reader.run', title: 'Run', slash: { name: 'read-file' } }] } })
  const command = base.contributes.commands[0]!
  for (const name of ['/read', 'Read', '读取', 'café', 'read file', 'read:1', '-read', 'read\u202E', '', 'a'.repeat(65)]) {
    expect(extensionManifestSchema.safeParse({ ...base, contributes: { commands: [{ ...command, slash: { name } }] } }).success, name).toBe(false)
  }
  for (const name of ['read-file', 'compact', 'review', 'start-2'])
    expect(extensionManifestSchema.safeParse({ ...base, contributes: { commands: [{ ...command, slash: { name } }] } }).success, name).toBe(true)
  expect(extensionManifestSchema.safeParse({ ...base, apiVersion: 2 }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...base, contributes: { commands: [{ ...command, hidden: true }] } }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...base, contributes: { commands: [command, { ...command, id: 'tests.reader.other' }] } }).success).toBe(false)
})

it('restricts transient interactions to absolute API 3 workbench and pane mounts', () => {
  const base = manifest({ apiVersion: 3, contributes: { views: [{ id: 'tests.reader.game', title: 'Game', entry: 'view.js', resource: 'none' }], placements: [{ id: 'tests.reader.layer', view: 'tests.reader.game', kind: 'view', target: 'workbench', interaction: 'regions', presentation: { position: 'absolute' } }] } })
  expect(extensionManifestSchema.safeParse({ ...base, apiVersion: 2 }).success).toBe(false)
  for (const target of ['app.sidebar', 'workbench.sidebar'])
    expect(extensionManifestSchema.safeParse({ ...base, contributes: { ...base.contributes, placements: [{ ...base.contributes.placements[0], target }] } }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...base, contributes: { ...base.contributes, placements: [{ ...base.contributes.placements[0], presentation: { position: 'static' } }] } }).success).toBe(false)
})
