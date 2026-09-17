import { Buffer } from 'node:buffer'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { CPU_ARCHITECTURE, OPERATING_SYSTEM } from '../../../apps/buddy/shared/platform/identifiers.ts'
import { writeError, writeOutput } from '../../shared/cli-output.mjs'
import { desktopArtifact } from '../release/artifacts.mjs'
import { macosSigningMode } from '../release/macos.mjs'
import { assertNativeExecutable } from '../release/native-host.mjs'
import { resolveBuildTarget } from '../release/targets.mjs'
import { verifyDesktopDirectory } from '../release/verify-package.mjs'
import { runDesktopSmoke } from './run-gui-smoke.mjs'

async function main() {
  if (process.platform !== OPERATING_SYSTEM.MacOS || process.arch !== CPU_ARCHITECTURE.ARM64)
    throw new Error('macOS install verification requires an Apple Silicon Mac')
  const target = resolveBuildTarget()
  const signing = macosSigningMode()
  const artifact = desktopArtifact(target, 'dmg')
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'lexora-macos-install-')))
  const mount = join(directory, 'volume')
  const installed = join(directory, 'Applications', 'lexora-buddy.app')
  let mounted = false
  try {
    mkdirSync(join(directory, 'Applications'))
    execFileSync('hdiutil', ['verify', artifact.path], { stdio: 'inherit', timeout: 120_000 })
    if (signing === 'developer-id') {
      execFileSync('xcrun', ['stapler', 'validate', artifact.path], { stdio: 'inherit', timeout: 120_000 })
      execFileSync('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', artifact.path], { stdio: 'inherit' })
    }
    execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, artifact.path], { stdio: 'inherit', timeout: 120_000 })
    mounted = true
    execFileSync('ditto', [join(mount, 'lexora-buddy.app'), installed], { stdio: 'inherit', timeout: 120_000 })
    execFileSync('hdiutil', ['detach', mount], { stdio: 'inherit', timeout: 30_000 })
    mounted = false
    verifyBundleArchitectures(installed)
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', installed], { stdio: 'inherit' })
    verifyFirstLaunchPolicy(installed, signing)
    const { executablePath, version } = verifyDesktopDirectory(installed, target.id)
    const resources = join(installed, 'Contents/Resources')
    const fixture = join(directory, '文档.txt')
    writeFileSync(fixture, 'native-reader-ready')
    const result = execFileSync(join(resources, 'native-host/lexora-buddy-file-reader'), [], {
      input: JSON.stringify({ root: directory, path: fixture, maxBytes: 64 }),
      encoding: 'utf8',
      timeout: 5000,
    })
    if (result !== 'native-reader-ready')
      throw new Error('Installed macOS file reader failed')
    for (const name of ['fd', 'rg'])
      execFileSync(join(resources, 'search-tools', name), ['--version'], { stdio: 'inherit', timeout: 5000 })
    const options = Buffer.from(JSON.stringify({ operation: 'chroma', options: { color: '#00ff00', tolerance: 10, softness: 20, despill: 1 } }))
    const size = Buffer.alloc(4)
    size.writeUInt32BE(options.length)
    const png = readFileSync(new URL('../../../apps/buddy/resources/icons/app-icon.png', import.meta.url))
    const transformed = execFileSync(join(resources, 'native-image/lexora-buddy-image-transform'), [], {
      input: Buffer.concat([size, options, png]),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000,
    })
    if (transformed.toString('hex', 0, 8) !== '89504e470d0a1a0a')
      throw new Error('Installed macOS image transformer failed')
    const lexoraHome = join(directory, '用户 Data')
    const environment = { ...process.env, LEXORA_HOME: lexoraHome }
    delete environment.ELECTRON_RUN_AS_NODE
    await runDesktopSmoke(executablePath, environment, 60_000)
    const database = new DatabaseSync(join(lexoraHome, 'buddy/buddy.sqlite3'), { readOnly: true })
    try {
      if (database.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok'
        || !(Number(database.prepare('PRAGMA user_version').get()?.user_version) > 0)) {
        throw new Error('Installed macOS database integrity check failed')
      }
    }
    finally {
      database.close()
    }
    await runDesktopSmoke(executablePath, environment, 60_000)
    const hash = createHash('sha256').update(readFileSync(artifact.path)).digest('hex')
    writeFileSync(join(dirname(artifact.path), 'SHA256SUMS.txt'), `${hash}  ${artifact.name}\n`)
    writeOutput(`Installed macOS Desktop ${version}: first-launch policy, native tools, startup, database, restart and shutdown passed (${signing})`)
  }
  finally {
    if (mounted)
      execFileSync('hdiutil', ['detach', '-force', mount], { stdio: 'inherit', timeout: 30_000 })
    rmSync(directory, { force: true, recursive: true })
  }
}

function verifyFirstLaunchPolicy(installed, signing) {
  const options = { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 120_000 }
  if (execFileSync('spctl', ['--status'], options).trim() !== 'assessments enabled')
    throw new Error('macOS first-launch verification requires Gatekeeper enabled')
  const quarantine = `0083;${Math.floor(Date.now() / 1000).toString(16)};LexoraAcceptance;${randomUUID()}`
  execFileSync('xattr', ['-r', '-w', 'com.apple.quarantine', quarantine, installed], options)
  if (execFileSync('xattr', ['-p', 'com.apple.quarantine', installed], options).trim() !== quarantine)
    throw new Error('macOS quarantine fixture was not applied')
  if (signing === 'developer-id') {
    execFileSync('xcrun', ['stapler', 'validate', installed], { ...options, stdio: 'inherit' })
    execFileSync('syspolicy_check', ['distribution', installed], { ...options, stdio: 'inherit' })
    writeOutput('Notarized macOS application passed distribution assessment with quarantine retained')
    return
  }
  const signature = spawnSync('codesign', ['--display', '--verbose=4', installed], options)
  if (signature.error || signature.status !== 0 || !signature.stderr.includes('Signature=adhoc'))
    throw new Error('macOS package must carry an ad-hoc signature')
  const assessment = spawnSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', installed], options)
  if (assessment.error || assessment.status !== 3 || !assessment.stderr.includes(': rejected'))
    throw new Error(`Expected Gatekeeper rejection of the ad-hoc application: ${assessment.error?.message ?? assessment.stderr}`)
  execFileSync('xattr', ['-r', '-d', 'com.apple.quarantine', installed], options)
  if (execFileSync('xattr', ['-r', installed], options).includes('com.apple.quarantine'))
    throw new Error('macOS application still has quarantine attributes after xattr')
  execFileSync('codesign', ['--verify', '--deep', '--strict', installed], { ...options, stdio: 'inherit' })
  writeOutput('Ad-hoc macOS application rejected by Gatekeeper; scoped xattr removal preserved the signature')
}

function verifyBundleArchitectures(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      verifyBundleArchitectures(path)
      continue
    }
    if (!entry.isFile())
      continue
    const file = openSync(path, 'r')
    try {
      const header = Buffer.alloc(32)
      const length = readSync(file, header, 0, header.length, 0)
      const magic = header.toString('hex', 0, 4)
      if (['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic))
        assertNativeExecutable(header.subarray(0, length), resolveBuildTarget(), path)
    }
    finally {
      closeSync(file)
    }
  }
}

void main().catch((error) => {
  writeError(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
