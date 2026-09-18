import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { build } from 'vite'
import { compileExtensionSource } from '../platform/extensions/compileExtensionSource.ts'
import { extensionCompatible, extensionManifestSchema, extensionPathSchema } from '../shared/extensions/extensionManifest.ts'

async function run() {
  const buddy = fileURLToPath(new URL('../', import.meta.url))
  const version = JSON.parse(await fs.readFile(path.join(buddy, 'buddy.version.json'), 'utf8')).version
  const [command, input, output] = process.argv.slice(2)
  assert(input && ['export-sdk', 'check', 'build', 'pack', 'dev'].includes(command), 'Usage: node extensions/tools.mjs export-sdk|check|build|pack|dev <folder> [output]')
  if (command === 'export-sdk') {
    const destination = path.resolve(input)
    await build({ configFile: false, publicDir: false, build: { outDir: destination, emptyOutDir: false, minify: false, lib: { entry: path.join(buddy, 'extensions/sdk/authoring.ts'), formats: ['es'], fileName: () => 'authoring.mjs' }, rollupOptions: { external: ['node:path', 'node:buffer', 'typescript', 'zod', 'semver'] } } })
    await fs.copyFile(path.join(buddy, 'service/resources/skills/plugin-creator/references/api.d.ts'), path.join(destination, 'index.d.ts'))
    await fs.copyFile(path.join(buddy, 'extensions/sdk/plugin.mjs'), path.join(destination, 'plugin.mjs'))
    return
  }
  const source = path.resolve(input)
  const manifest = extensionManifestSchema.parse(JSON.parse(await fs.readFile(path.join(source, 'extension.json'), 'utf8')))
  assert(extensionCompatible(manifest, version), `Extension requires Lexora ${manifest.engines.lexora} / API ${manifest.apiVersion}`)
  const entries = [manifest.entry, ...manifest.contributes.views.map(view => view.entry)].filter(Boolean)
  for (const entry of entries) assert((await fs.stat(path.join(source, entry))).isFile(), `Missing entry: ${entry}`)
  if (command === 'check') {
    process.stdout.write(`${manifest.id}@${manifest.version}: compatible with Lexora ${version}, API 1` + '\n')
  }
  else if (command === 'pack') {
    assert(output, 'An output package path is required')
    const files = {}
    let total = 0
    const names = new Set()
    async function walk(folder) {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        const absolute = path.join(folder, entry.name)
        const name = path.relative(source, absolute).split(path.sep).join('/')
        extensionPathSchema.parse(name)
        assert(!entry.isSymbolicLink(), `Symlink rejected: ${name}`)
        if (entry.isDirectory()) {
          await walk(absolute)
          continue
        }
        assert(entry.isFile(), `Not a file: ${name}`)
        assert(!names.has(name.toLowerCase()), `Duplicate path: ${name}`)
        names.add(name.toLowerCase())
        assert(names.size <= 512, 'Too many files')
        const stat = await fs.stat(absolute)
        assert(stat.size <= 4 * 1024 * 1024, 'File exceeds 4 MiB')
        const bytes = await fs.readFile(absolute)
        total += bytes.length
        assert(total <= 16 * 1024 * 1024, 'Package exceeds 16 MiB')
        files[name] = bytes
      }
    }
    await walk(source)
    const bytes = zipSync(files, { level: 6 })
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true })
    await fs.writeFile(output, bytes)
    process.stdout.write(`${path.resolve(output)} (${bytes.length} bytes, SHA-256 ${createHash('sha256').update(bytes).digest('hex')})` + '\n')
  }
  else {
    const development = command === 'dev'
    const home = development ? await fs.mkdtemp(path.join(os.tmpdir(), 'lexora-extension-dev-')) : null
    assert(home || output, 'An output directory is required')
    const destination = path.resolve(home ? path.join(home, 'package') : output)
    assert(destination !== source && !source.startsWith(`${destination}${path.sep}`), 'Output must not contain the source directory')
    const existing = await fs.readdir(destination).catch((error) => {
      if (error.code === 'ENOENT')
        return []
      throw error
    })
    if (existing.length)
      assert(JSON.parse(await fs.readFile(path.join(destination, 'extension.json'), 'utf8')).id === manifest.id, 'Output belongs to a different extension')
    if (manifest.format === 'source') {
      const files = new Map()
      async function collect(folder) {
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
          assert(!entry.isSymbolicLink(), 'Symlinks are not supported')
          const absolute = path.join(folder, entry.name)
          if (entry.isDirectory())
            await collect(absolute)
          else files.set(path.relative(source, absolute).split(path.sep).join('/'), await fs.readFile(absolute))
        }
      }
      await collect(source)
      const compiled = compileExtensionSource(files, manifest, message => process.stdout.write(`${message}\n`))
      await fs.rm(destination, { recursive: true, force: true })
      for (const [name, bytes] of compiled) {
        await fs.mkdir(path.dirname(path.join(destination, name)), { recursive: true })
        await fs.writeFile(path.join(destination, name), bytes)
      }
    }
    else {
      await build({ configFile: false, root: source, build: { outDir: destination, emptyOutDir: true, minify: false, lib: { entry: Object.fromEntries(entries.map(entry => [entry.replace(/\.[^.]+$/, ''), path.join(source, entry)])), formats: ['es'] }, rollupOptions: { output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js', assetFileNames: 'assets/[name][extname]' } } } })
      const compiledManifest = { ...manifest, entry: manifest.entry?.replace(/\.[^.]+$/, '.js'), contributes: { ...manifest.contributes, views: manifest.contributes.views.map(view => ({ ...view, entry: view.entry.replace(/\.[^.]+$/, '.js') })) } }
      await fs.writeFile(path.join(destination, 'extension.json'), JSON.stringify(compiledManifest, null, 2))
    }
    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
      await fs.copyFile(path.join(source, name), path.join(destination, name)).catch((error) => {
        if (error.code !== 'ENOENT')
          throw error
      })
    }
    if (development) {
      await fs.mkdir(path.join(home, 'buddy'), { recursive: true })
      await fs.writeFile(path.join(home, 'config.toml'), '[desktop]\nlanguage="zh-CN"\n[pet]\nenabled=false\n')
      process.stdout.write(`Development profile: ${home}\nPermissions: ${JSON.stringify(manifest.permissions)}\nClose the development window to stop. This profile is retained for inspection.` + '\n')
      const { ELECTRON_RUN_AS_NODE: _node, ...environment } = process.env
      const executable = (await import('electron')).default
      const child = spawn(executable, [...(process.platform === 'linux' ? ['--disable-setuid-sandbox'] : []), buddy], { cwd: buddy, stdio: 'inherit', env: { ...environment, LEXORA_HOME: home, LEXORA_BUDDY_PROFILE: 'test', LEXORA_EXTENSION_DEVELOPMENT_PATH: destination } })
      process.on('SIGINT', () => child.kill('SIGINT'))
      process.on('SIGTERM', () => child.kill('SIGTERM'))
      child.once('exit', (code) => {
        process.exitCode = code ?? 1
      })
    }
  }
}
void run().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
