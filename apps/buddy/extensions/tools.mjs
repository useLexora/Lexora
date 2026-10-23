import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { buildExtensionDirectory, packExtensionDirectory, readExtensionPackage } from '../platform/extensions/extensionPackageAuthoring.ts'
import { extensionCompatible, extensionManifestSchema } from '../shared/extensions/extensionManifest.ts'

async function run() {
  const buddy = fileURLToPath(new URL('../', import.meta.url))
  const version = JSON.parse(await fs.readFile(path.join(buddy, 'buddy.version.json'), 'utf8')).version
  const [command, input, output] = process.argv.slice(2)
  assert(input && ['export-sdk', 'check', 'build', 'pack', 'dev'].includes(command), 'Usage: node extensions/tools.mjs export-sdk|check|build|pack|dev <folder> [output]')
  if (command === 'export-sdk') {
    const destination = path.resolve(input)
    await build({ configFile: false, publicDir: false, build: { outDir: destination, emptyOutDir: false, minify: false, lib: { entry: path.join(buddy, 'extensions/sdk/authoring.ts'), formats: ['es'], fileName: () => 'authoring.mjs' }, rolldownOptions: { external: [/^node:/, 'typescript', 'zod', 'semver'] } } })
    await fs.copyFile(path.join(buddy, 'service/resources/skills/plugin-creator/references/api.d.ts'), path.join(destination, 'index.d.ts'))
    await fs.copyFile(path.join(buddy, 'extensions/sdk/plugin.mjs'), path.join(destination, 'plugin.mjs'))
    return
  }
  const source = path.resolve(input)
  const manifest = extensionManifestSchema.parse(JSON.parse(await fs.readFile(path.join(source, 'extension.json'), 'utf8')))
  assert(extensionCompatible(manifest, version), `Extension requires Lexora ${manifest.engines.lexora} / API ${manifest.apiVersion}`)
  if (command === 'check') {
    await readExtensionPackage(source)
    process.stdout.write(`${manifest.id}@${manifest.version}: compatible with Lexora ${version}, API ${manifest.apiVersion}` + '\n')
  }
  else if (command === 'pack') {
    assert(output, 'An output package path is required')
    const result = await packExtensionDirectory(source, output)
    process.stdout.write(`${path.resolve(output)} (${result.size} bytes, SHA-256 ${result.sha256})` + '\n')
  }
  else {
    const development = command === 'dev'
    const home = development ? await fs.mkdtemp(path.join(os.tmpdir(), 'lexora-extension-dev-')) : null
    assert(home || output, 'An output directory is required')
    const destination = path.resolve(home ? path.join(home, 'package') : output)
    await buildExtensionDirectory(source, destination, message => process.stdout.write(`${message}\n`))
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
