import type { z } from 'zod'
import type { ExtensionManifest } from '../../../shared/extensions/extensionManifest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { extensionManifestSchema } from '../../../shared/extensions/extensionManifest'
import { ExtensionPackageStore } from '../ExtensionPackageStore'

export function manifest(input: Partial<z.input<typeof extensionManifestSchema>> = {}): ExtensionManifest {
  const id = input.id ?? 'tests.reader'
  return extensionManifestSchema.parse({ schemaVersion: 1, id, name: 'Fixture reader', version: '1.0.0', apiVersion: 1, engines: { lexora: '^0.7.3' }, entry: 'extension.js', permissions: { selectedResource: 'read', network: [] }, contributes: { commands: [{ id: `${id}.open`, title: 'Open' }], views: [{ id: `${id}.reader`, title: 'Reader', entry: 'view.js' }] }, ...input })
}
export async function createStore() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-extension-spec-'))
  const store = new ExtensionPackageStore(join(root, 'extensions'), '0.7.3')
  await store.load()
  return { root, store }
}
export async function reviewPackage(root: string, store: ExtensionPackageStore, input: ExtensionManifest = manifest(), files: Record<string, string> = {}) {
  const path = join(root, `${randomUUID()}.lexora-extension`)
  const values = { 'extension.json': JSON.stringify(input), 'extension.js': 'export function activate() {}', 'view.js': 'export function render() {}', ...files }
  await writeFile(path, zipSync(Object.fromEntries(Object.entries(values).map(([name, value]) => [name, strToU8(value)]))))
  return store.review(path)
}
