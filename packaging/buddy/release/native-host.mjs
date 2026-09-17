import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import nativeHost from '../../../apps/buddy/platform/native/nativeHost.json' with { type: 'json' }
import { OPERATING_SYSTEM } from '../../../apps/buddy/shared/platform/identifiers.ts'
import { requireNativeBuildTarget, resolveBuildTarget } from './targets.mjs'

const buddyRoot = fileURLToPath(new URL('../../../apps/buddy/', import.meta.url))

export function nativeHostResources(target) {
  return target.nativeComponents.map((name) => {
    const component = nativeHost.components[name]
    if (!component)
      throw new Error(`Missing native component definition: ${target.id} ${name}`)
    const executable = `${component.binary}${target.platform === OPERATING_SYSTEM.Windows ? '.exe' : ''}`
    return { name, ...component, from: `${nativeHost.directory}/${target.rustTarget}/release/${executable}`, to: `${component.directory}/${executable}` }
  })
}

export function prepareNativeHost(target = resolveBuildTarget()) {
  requireNativeBuildTarget(target)
  for (const component of nativeHostResources(target)) {
    execFileSync('cargo', [
      'rustc',
      '--locked',
      '--release',
      '--target',
      target.rustTarget,
      '--target-dir',
      nativeHost.directory,
      '--manifest-path',
      nativeHost.manifest,
      '--package',
      component.package,
      '--bin',
      component.binary,
      ...(target.platform === OPERATING_SYSTEM.Windows ? ['--', '-C', 'target-feature=+crt-static'] : []),
    ], {
      cwd: buddyRoot,
      stdio: 'inherit',
      env: { ...process.env, ...(target.minimumSystemVersion ? { MACOSX_DEPLOYMENT_TARGET: target.minimumSystemVersion } : {}) },
    })
  }
}

export function verifyNativeHostFiles(readResource, target) {
  for (const { to: path } of nativeHostResources(target))
    assertNativeExecutable(readResource(path), target, path)
}

export function assertNativeExecutable(bytes, target, path) {
  const { platform, architecture } = resolveBuildTarget(target.id)
  let valid = false
  if (platform === OPERATING_SYSTEM.Linux) {
    valid = bytes.length >= 20 && bytes.toString('hex', 0, 6) === '7f454c460201'
      && bytes.readUInt16LE(18) === { x64: 62, arm64: 183 }[architecture]
  }
  else if (platform === OPERATING_SYSTEM.Windows) {
    const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3C) : -1
    valid = bytes.toString('ascii', 0, 2) === 'MZ' && offset >= 0 && offset + 6 <= bytes.length
      && bytes.readUInt32LE(offset) === 0x4550 && bytes.readUInt16LE(offset + 4) === { x64: 0x8664, arm64: 0xAA64 }[architecture]
  }
  else if (platform === OPERATING_SYSTEM.MacOS) {
    valid = bytes.length >= 32 && bytes.readUInt32LE(0) === 0xFEEDFACF
      && bytes.readUInt32LE(4) === { x64: 0x01000007, arm64: 0x0100000C }[architecture]
  }
  if (!valid)
    throw new Error(`Expected a ${target.id} native executable: ${path}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  prepareNativeHost()
