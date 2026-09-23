import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import targets from '../../../apps/buddy/platform/targets.json' with { type: 'json' }
import definitions from '../../../apps/buddy/shared/platform/definitions.json' with { type: 'json' }
import { CPU_ARCHITECTURE } from '../../../apps/buddy/shared/platform/identifiers.ts'

const packaging = {
  linux: { builderPlatform: 'linux', packageFormats: ['deb', 'pacman'] },
  win32: { builderPlatform: 'win', packageFormats: ['nsis'] },
  darwin: { builderPlatform: 'mac', packageFormats: ['dmg'], minimumSystemVersion: '15.0' },
}

export function resolveBuildTarget(id = `${process.platform}-${process.arch}`) {
  if (!Object.hasOwn(targets, id))
    throw new Error(`Unsupported Buddy target: ${id}`)
  const target = targets[id]
  return { ...target, ...packaging[target.platform], id, features: definitions.platforms[target.platform].features }
}

export function requirePackageFormat(target, format) {
  if (!target.packageFormats.includes(format) || (format === 'pacman' && target.architecture !== CPU_ARCHITECTURE.X64))
    throw new Error(`Unsupported Buddy package: ${target.id} ${format}`)
}

export function requireNativeBuildTarget(target) {
  if (target.platform !== process.platform || target.architecture !== process.arch)
    throw new Error(`${target.id} requires a matching native build host; current host is ${process.platform}-${process.arch}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'target': { type: 'string' }, 'github-output': { type: 'string' } } })
  const target = resolveBuildTarget(values.target)
  requireNativeBuildTarget(target)
  if (!values['github-output'])
    throw new Error('Usage: targets.mjs [--target <os-architecture>] --github-output <path>')
  appendFileSync(values['github-output'], `rust-target=${target.rustTarget}\ncargo-args=${target.features.includes('nativePet') ? '' : '--exclude lexora-buddy-pet'}\nminimum-system-version=${target.minimumSystemVersion ?? ''}\n`)
}
