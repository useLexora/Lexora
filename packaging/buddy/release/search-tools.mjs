import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import searchTools from '../../../apps/buddy/platform/native/searchTools.json' with { type: 'json' }
import { OPERATING_SYSTEM } from '../../../apps/buddy/shared/platform/identifiers.ts'
import { writeError, writeOutput } from '../../shared/cli-output.mjs'
import { assertNativeExecutable } from './native-host.mjs'
import { resolveBuddyOutputPaths } from './output-paths.mjs'
import { resolveBuildTarget } from './targets.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')

export function resolveSearchTools(platformId, architecture) {
  const target = `${platformId}-${architecture}`
  resolveBuildTarget(target)
  return Object.entries(searchTools.tools).map(([name, tool]) => {
    if (!Object.hasOwn(tool.targets, target))
      throw new Error(`Unsupported search tools target: ${target}`)
    return { name, ...tool, ...tool.targets[target] }
  })
}

export function verifySearchToolFiles(readEntry, platformId, architecture, { signed = false } = {}) {
  for (const tool of resolveSearchTools(platformId, architecture)) {
    const bytes = readEntry(tool.binary)
    assertNativeExecutable(bytes, resolveBuildTarget(`${platformId}-${architecture}`), tool.binary)
    if (!signed || platformId !== OPERATING_SYSTEM.MacOS)
      assertSha256(bytes, tool.binarySha256, tool.binary)
    for (const license of tool.licenses) {
      const entry = `licenses/${tool.name}/${license}`
      if (!readEntry(entry).length)
        throw new Error(`Search tool license is empty: ${entry}`)
    }
  }
}

export async function prepareSearchTools({ cwd = repoRoot, platformId = process.platform, architecture = process.arch } = {}) {
  const tools = resolveSearchTools(platformId, architecture)
  const paths = resolveBuddyOutputPaths(cwd)
  const parent = join(paths.buddyRoot, searchTools.resource.from)
  const output = join(parent, `${platformId}-${architecture}`)
  const verifyDirectory = (directory) => {
    verifySearchToolFiles(entry => readFileSync(join(directory, entry)), platformId, architecture)
    if (platformId === process.platform && architecture === process.arch) {
      for (const tool of tools)
        execFileSync(join(directory, tool.binary), ['--version'], { timeout: 5000, stdio: 'pipe' })
    }
  }
  if (existsSync(output)) {
    try {
      verifyDirectory(output)
      return output
    }
    catch {
      // Rebuild incomplete or outdated generated resources from pinned archives.
    }
  }
  mkdirSync(parent, { recursive: true })
  const staging = mkdtempSync(join(parent, `${platformId}-${architecture}-`))
  const cache = join(paths.outputRoot, 'cache/search-tools')
  mkdirSync(cache, { recursive: true })
  try {
    for (const tool of tools) {
      const archive = await prepareArchive(tool, cache)
      const root = tool.archive.replace(/\.(tar\.gz|zip)$/, '')
      writeFileSync(join(staging, tool.binary), extractEntry(archive, `${root}/${tool.binary}`), { mode: 0o755 })
      const licenses = join(staging, 'licenses', tool.name)
      mkdirSync(licenses, { recursive: true })
      for (const license of tool.licenses)
        writeFileSync(join(licenses, license), extractEntry(archive, `${root}/${license}`))
    }
    verifyDirectory(staging)
    rmSync(output, { recursive: true, force: true })
    renameSync(staging, output)
    return output
  }
  finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

async function prepareArchive(tool, cache) {
  const path = join(cache, tool.archive)
  if (existsSync(path)) {
    assertSha256(readFileSync(path), tool.sha256, tool.archive)
    return path
  }
  writeOutput(`Preparing ${tool.name} ${tool.version}: ${tool.archive}`)
  const response = await fetch(`${tool.release}/${tool.archive}`, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok)
    throw new Error(`Unable to download ${tool.archive}: HTTP ${response.status}`)
  const content = Buffer.from(await response.arrayBuffer())
  assertSha256(content, tool.sha256, tool.archive)
  const staging = mkdtempSync(join(cache, 'download-'))
  try {
    const candidate = join(staging, tool.archive)
    writeFileSync(candidate, content)
    renameSync(candidate, path)
  }
  finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return path
}

function extractEntry(archive, entry) {
  const extractors = {
    darwin: () => ['tar', ['-xOf', archive, entry]],
    linux: () => archive.endsWith('.zip')
      ? ['unzip', ['-p', archive, entry]]
      : ['tar', ['-xOf', archive, entry]],
    win32: () => [join(process.env.SystemRoot, 'System32/tar.exe'), ['-xOf', archive, entry]],
  }
  const extractor = extractors[process.platform]
  if (!extractor)
    throw new Error(`Unsupported build host: ${process.platform}`)
  const [command, args] = extractor()
  return execFileSync(command, args, { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })
}

function assertSha256(content, expected, name) {
  if (createHash('sha256').update(content).digest('hex') !== expected)
    throw new Error(`Search tool checksum mismatch: ${name}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--target'))
    throw new Error('Usage: search-tools.mjs [--target <os-architecture>]')
  const target = resolveBuildTarget(args[1])
  void prepareSearchTools({ platformId: target.platform, architecture: target.architecture }).then(writeOutput).catch((error) => {
    writeError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
