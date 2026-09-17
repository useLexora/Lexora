import type { PlatformTarget } from '../shared/platform'
import process from 'node:process'
import { buddyArchitectureSchema, resolveBuddyPlatform } from '../shared/platform'
import targets from './targets.json'

export type BuddyTargetId = keyof typeof targets

export interface BuddyTarget extends PlatformTarget {
  id: BuddyTargetId
  rustTarget: string
  nativeComponents: readonly string[]
}

export function resolveBuddyTarget(platform: string = process.platform, architecture: string = process.arch): BuddyTarget {
  const id = `${platform}-${architecture}`
  if (!Object.hasOwn(targets, id))
    throw new Error(`Unsupported Buddy target: ${id}`)
  const definition = targets[id as BuddyTargetId]
  return { ...definition, id: id as BuddyTargetId, platform: resolveBuddyPlatform(definition.platform).id, architecture: buddyArchitectureSchema.parse(definition.architecture) }
}

export const currentTarget = resolveBuddyTarget()
