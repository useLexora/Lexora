import type { ServiceResourceLocation } from '../service/serviceResources'
import process from 'node:process'
import { isWindows } from '../../shared/platform/identifiers'
import { resolveServiceResource } from '../service/serviceResources'
import { resolveBuddyTarget } from '../target'
import nativeHost from './nativeHost.json'

export function createBuddyNativeEnvironment(options: ServiceResourceLocation): Record<string, string> {
  const reader = resolveBuddyFileReader(options)
  const serviceControl = resolveBuddyServiceControl(options)
  const processControl = resolveBuddyProcessControl(options)
  const runtimeGuard = resolveNativeComponent('runtimeGuard', options)
  return {
    LEXORA_BUDDY_FILE_READER: reader,
    ...(serviceControl ? { LEXORA_BUDDY_SERVICE_CONTROL: serviceControl } : {}),
    ...(processControl ? { LEXORA_BUDDY_PROCESS_CONTROL: processControl } : {}),
    ...(runtimeGuard ? { LEXORA_BUDDY_RUNTIME_GUARD: runtimeGuard } : {}),
    LEXORA_BUDDY_IMAGE_TRANSFORMER: resolveBuddyImageTransformer(options),
  }
}

export function resolveBuddyFileReader(options: ServiceResourceLocation): string {
  return requireNativeComponent('fileReader', options)
}

export function resolveBuddyServiceControl(options: ServiceResourceLocation): string | undefined {
  return resolveNativeComponent('serviceControl', options)
}

export function resolveBuddyProcessControl(options: ServiceResourceLocation): string | undefined {
  return resolveNativeComponent('processControl', options)
}

export function resolveBuddyPrivateDirectories(options: ServiceResourceLocation): string | undefined {
  return resolveNativeComponent('privateDirectories', options)
}

export function resolveBuddyShellSandbox(options: ServiceResourceLocation): string | undefined {
  return resolveNativeComponent('shellSandbox', options)
}

export function resolveBuddyImageTransformer(options: ServiceResourceLocation): string {
  return requireNativeComponent('imageTransform', options)
}

function requireNativeComponent(name: keyof typeof nativeHost.components, options: ServiceResourceLocation): string {
  const executable = resolveNativeComponent(name, options)
  if (!executable)
    throw new Error(`Missing required Buddy native component: ${name}`)
  return executable
}

function resolveNativeComponent(name: keyof typeof nativeHost.components, options: ServiceResourceLocation): string | undefined {
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const target = resolveBuddyTarget(platform, architecture)
  const component = nativeHost.components[name]
  if (!target.nativeComponents.includes(name))
    return undefined
  const executable = `${component.binary}${isWindows(platform) ? '.exe' : ''}`
  return resolveServiceResource(options, `${component.directory}/${executable}`, `${nativeHost.directory}/${target.rustTarget}/release/${executable}`)
}
