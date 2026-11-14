import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import runtime from '../../../apps/buddy/platform/native/nodeRuntime.json' with { type: 'json' }
import { writeOutput } from '../../shared/cli-output.mjs'
import { assertNativeExecutable } from './native-host.mjs'
import { resolveBuildTarget } from './targets.mjs'

export async function prepareNodeRuntime(target = resolveBuildTarget(), cwd = resolve(import.meta.dirname, '../../..')) {
  const source = runtime.targets[target.id]
  assert(source, `Node runtime is unavailable for ${target.id}`)
  const parent = join(cwd, 'apps/buddy', runtime.resource.from)
  const output = join(parent, target.id)
  function verify(directory) {
    const metadata = JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8'))
    assert.equal(metadata.version, runtime.version)
    assert.equal(metadata.archiveSha256, source.sha256)
    const bytes = readFileSync(join(directory, source.binary))
    assert.equal(digest(bytes), metadata.binarySha256)
    assertNativeExecutable(bytes, target, source.binary)
    assert(readFileSync(join(directory, 'LICENSE')).length)
    if (target.platform === process.platform && target.architecture === process.arch)
      assert.equal(execFileSync(join(directory, source.binary), ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(), `v${runtime.version}`)
  }
  if (existsSync(output)) {
    try {
      verify(output)
      return output
    }
    catch {}
  }
  mkdirSync(parent, { recursive: true })
  const staging = mkdtempSync(join(parent, `${target.id}-`))
  const cache = join(cwd, 'apps/buddy/.output/cache/node-runtime')
  mkdirSync(cache, { recursive: true })
  const archive = join(cache, source.archive)
  try {
    if (!existsSync(archive)) {
      writeOutput(`Preparing Node ${runtime.version}: ${target.id}`)
      const response = await fetch(`${runtime.release}/${source.archive}`, { signal: AbortSignal.timeout(60_000) })
      assert(response.ok, `Node download failed: HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.equal(digest(bytes), source.sha256, 'Node archive checksum mismatch')
      const temporary = join(staging, source.archive)
      writeFileSync(temporary, bytes)
      renameSync(temporary, archive)
    }
    assert.equal(digest(readFileSync(archive)), source.sha256, 'Node archive checksum mismatch')
    const binary = extract(archive, source.entry)
    writeFileSync(join(staging, source.binary), binary, { mode: 0o755 })
    writeFileSync(join(staging, 'LICENSE'), extract(archive, source.license))
    writeFileSync(join(staging, 'runtime.json'), `${JSON.stringify({ version: runtime.version, target: target.id, archiveSha256: source.sha256, binarySha256: digest(binary) }, null, 2)}\n`)
    verify(staging)
    rmSync(output, { recursive: true, force: true })
    renameSync(staging, output)
    return output
  }
  finally { rmSync(staging, { recursive: true, force: true }) }
}

function extract(archive, entry) {
  const command = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32/tar.exe') : archive.endsWith('.zip') ? 'unzip' : 'tar'
  return execFileSync(command, command === 'unzip' ? ['-p', archive, entry] : ['-xOf', archive, entry], { maxBuffer: 160 * 1024 * 1024, timeout: 30_000 })
}
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  assert(args.length === 0 || (args.length === 2 && args[0] === '--target'), 'Usage: node-runtime.mjs [--target <os-architecture>]')
  void prepareNodeRuntime(resolveBuildTarget(args[1])).then(writeOutput).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
