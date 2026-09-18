import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { zipSync } from 'fflate'
import { compileExtensionSource, extensionIconUrl, extensionManifestSchema, extensionPathSchema } from './authoring.mjs'

export async function readPlugin(source) {
  const files = new Map()
  let total = 0
  const names = new Set()
  async function visit(folder) {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      assert(!item.isSymbolicLink(), `Symlink rejected: ${item.name}`)
      const absolute = path.join(folder, item.name)
      const name = path.relative(source, absolute).split(path.sep).join('/')
      extensionPathSchema.parse(name)
      if (item.isDirectory()) {
        await visit(absolute)
        continue
      }
      assert(item.isFile() && !names.has(name.toLowerCase()), `Invalid file: ${name}`)
      const stat = await fs.stat(absolute)
      assert(stat.size <= 4 * 1024 * 1024, `File too large: ${name}`)
      const bytes = await fs.readFile(absolute)
      total += bytes.length
      names.add(name.toLowerCase())
      assert(total <= 16 * 1024 * 1024 && names.size <= 512, 'Plugin package exceeds limits')
      files.set(name, bytes)
    }
  }
  await visit(path.resolve(source))
  const manifest = extensionManifestSchema.parse(JSON.parse(new TextDecoder().decode(files.get('extension.json'))))
  for (const entry of [manifest.entry, ...manifest.contributes.views.map(view => view.entry)].filter(Boolean))
    assert(files.has(entry), `Missing entry: ${entry}`)
  const iconUrl = extensionIconUrl(manifest.icon, manifest.icon ? files.get(manifest.icon) : undefined)
  return { manifest, files, iconUrl }
}

export async function buildPlugin(source, destination, report = () => {}) {
  source = path.resolve(source)
  destination = path.resolve(destination)
  assert(source !== destination && !source.startsWith(`${destination}${path.sep}`), 'Output must not contain source')
  const { files, manifest } = await readPlugin(source)
  const result = manifest.format === 'source' ? compileExtensionSource(files, manifest, report) : files
  const old = await fs.readdir(destination).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))
  if (old.length)
    assert(JSON.parse(await fs.readFile(path.join(destination, 'extension.json'), 'utf8')).id === manifest.id, 'Output belongs to another plugin')
  await fs.rm(destination, { recursive: true, force: true })
  for (const [name, bytes] of result) {
    await fs.mkdir(path.dirname(path.join(destination, name)), { recursive: true })
    await fs.writeFile(path.join(destination, name), bytes)
  }
  return extensionManifestSchema.parse(JSON.parse(new TextDecoder().decode(result.get('extension.json'))))
}

export async function packPlugin(source, destination, { license } = {}) {
  const { files, manifest, iconUrl } = await readPlugin(source)
  if (license && !files.has('LICENSE'))
    files.set('LICENSE', license)
  const bytes = zipSync(Object.fromEntries(files), { level: 6, mtime: new Date('2020-01-01T00:00:00Z') })
  await fs.mkdir(path.dirname(path.resolve(destination)), { recursive: true })
  await fs.writeFile(destination, bytes)
  return { manifest, iconUrl, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}
