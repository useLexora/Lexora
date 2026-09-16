import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { writeOutput } from '../../shared/cli-output.mjs'
import { assertNativeExecutable, verifyNativeHostFiles } from './native-host.mjs'
import { excludedPlatformResources, platformResources, resolvePackagingPlatform } from './platform-definition.mjs'
import { verifySearchToolFiles } from './search-tools.mjs'
import { verifyShellSandboxFiles } from './shell-sandbox.mjs'
import { readBuddyReleaseMetadata } from './verify-release-artifacts.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')

export function verifyDesktopDirectory(directory, platformId, cwd = repoRoot) {
  const platform = resolvePackagingPlatform(platformId)
  const executablePath = join(directory, platformId === 'win32' ? 'Lexora Buddy.exe' : 'lexora-buddy')
  assertNativeExecutable(readFileSync(executablePath), platformId, executablePath)
  const resources = join(directory, 'resources')
  for (const { to: path } of platformResources(platform)) {
    if (!existsSync(join(resources, path)))
      throw new Error(`Desktop is missing ${path}`)
  }
  for (const { to: path } of excludedPlatformResources(platform)) {
    if (existsSync(join(resources, path)))
      throw new Error(`Desktop must not contain ${path} on ${platformId}`)
  }
  verifyNativeHostFiles(entry => readFileSync(join(resources, entry)), platformId)
  verifySearchToolFiles(entry => readFileSync(join(resources, 'search-tools', entry)), platformId)
  if (platformId === 'linux')
    verifyShellSandboxFiles(entry => readFileSync(join(resources, 'shell-sandbox', entry)))
  else if (existsSync(join(resources, 'shell-sandbox')))
    throw new Error('Windows Desktop must not contain the Linux shell sandbox')
  if (platform.features.includes('nativePet'))
    assertNativeExecutable(readFileSync(join(resources, 'native-pet/lexora-buddy-pet')), platformId, 'native pet')

  const require = createRequire(join(cwd, 'apps/buddy/package.json'))
  const builder = createRequire(require.resolve('electron-builder'))
  const asar = createRequire(builder.resolve('app-builder-lib'))('@electron/asar')
  const archive = join(resources, 'app.asar')
  const entries = asar.listPackage(archive).map(entry => entry.replaceAll('\\', '/').replace(/^\//, ''))
  for (const entry of ['main/index.js', 'main/buddy-service.js', 'preload/index.cjs', 'renderer/index.html']) {
    if (!entries.includes(`.output/build/electron/${entry}`))
      throw new Error(`Desktop archive is missing ${entry}`)
  }
  if (entries.some(entry => entry.split('/').includes('__tests__')))
    throw new Error('Desktop archive contains test files')
  if (platformId === 'linux') {
    const seccomp = join(resources, 'app.asar.unpacked/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp')
    assertNativeExecutable(readFileSync(seccomp), 'linux', 'shell seccomp helper')
  }
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
  const { version } = readBuddyReleaseMetadata(cwd)
  if (packaged.version !== version)
    throw new Error('Desktop version does not match Buddy metadata')
  return { executablePath, version }
}

export function verifyLinuxPackage(target, artifact, cwd = repoRoot) {
  if (!['deb', 'pacman'].includes(target))
    throw new Error(`Unsupported Linux package target: ${target}`)
  const directory = mkdtempSync(join(tmpdir(), 'lexora-package-'))
  try {
    execFileSync('bsdtar', ['-xf', resolve(artifact), '-C', directory])
    let metadata
    if (target === 'deb') {
      const members = readdirSync(directory)
      const control = members.find(name => /^control\.tar\./.test(name))
      const data = members.find(name => /^data\.tar\./.test(name))
      if (!control || !data)
        throw new Error('Deb control or data archive is missing')
      metadata = execFileSync('bsdtar', ['-xOf', join(directory, control), './control'], { encoding: 'utf8' })
      execFileSync('bsdtar', ['-xf', join(directory, data), '-C', directory])
    }
    else {
      metadata = readFileSync(join(directory, '.PKGINFO'), 'utf8')
    }
    const { version } = readBuddyReleaseMetadata(cwd)
    verifyLinuxMetadata(target, metadata, version)
    const result = verifyDesktopDirectory(join(directory, 'opt/lexora-buddy'), 'linux', cwd)
    const { desktopName, productName } = JSON.parse(readFileSync(join(cwd, 'apps/buddy/package.json'), 'utf8'))
    const desktop = readFileSync(join(directory, `usr/share/applications/${desktopName}.desktop`), 'utf8')
    for (const entry of [`Name=${productName}`, 'Exec=/opt/lexora-buddy/lexora-buddy %U', 'Icon=lexora-buddy', `StartupWMClass=${desktopName}`]) {
      if (!desktop.split(/\r?\n/).includes(entry))
        throw new Error(`Desktop entry is missing ${entry}`)
    }
    if (!existsSync(join(directory, 'usr/share/icons/hicolor/512x512/apps/lexora-buddy.png')))
      throw new Error('Desktop package icon is missing')
    return result
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function verifyLinuxMetadata(target, content, version) {
  const deb = target === 'deb'
  const fields = new Map()
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(deb ? /^([^:]+):(.*)$/ : /^([^ ]+) = (.*)$/)
    if (match)
      fields.set(match[1], [...fields.get(match[1]) ?? [], match[2].trim()])
  }
  const expected = deb
    ? { Package: 'lexora-buddy', Version: version, Architecture: 'amd64' }
    : { pkgname: 'lexora-buddy', pkgver: `${version}-1`, arch: 'x86_64' }
  for (const [key, value] of Object.entries(expected)) {
    if (fields.get(key)?.[0] !== value)
      throw new Error(`${target} ${key} must be ${value}`)
  }
  const dependencies = deb
    ? (fields.get('Depends') ?? []).flatMap(value => value.split(',').map(item => item.trim().split(/[ (]/)[0]))
    : fields.get('depend') ?? []
  const required = deb ? ['git', 'libcap2', 'socat', 'libgtk-3-0', 'libgtk-layer-shell0', 'webp-pixbuf-loader'] : ['git', 'libcap', 'socat', 'gtk3', 'gtk-layer-shell']
  for (const dependency of required) {
    if (!dependencies.includes(dependency))
      throw new Error(`${target} dependency is missing: ${dependency}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--target' || !['deb', 'pacman'].includes(args[1]))
    throw new Error('Usage: verify-package.mjs --target deb|pacman')
  const artifact = readBuddyReleaseMetadata().artifacts.find(entry => entry.target === args[1])
  verifyLinuxPackage(artifact.target, artifact.path)
  writeOutput(`Desktop package verified: ${artifact.name}`)
}
