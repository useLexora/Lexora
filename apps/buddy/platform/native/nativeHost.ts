import { posix, win32 } from 'node:path'
import process from 'node:process'
import { isWindows } from '../../shared/platform/identifiers'
import { resolveBuddyTarget } from '../target'
import nativeHost from './nativeHost.json'

interface NativeHostPaths {
  appPath: string
  isPackaged: boolean
  resourcesPath: string
  platform?: NodeJS.Platform
  architecture?: string
}

export function createBuddyNativeEnvironment(options: NativeHostPaths): Record<string, string> {
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

export function resolveBuddyFileReader(options: NativeHostPaths): string {
  return requireNativeComponent('fileReader', options)
}

export function resolveBuddyServiceControl(options: NativeHostPaths): string | undefined {
  return resolveNativeComponent('serviceControl', options)
}

export function resolveBuddyProcessControl(options: NativeHostPaths): string | undefined {
  return resolveNativeComponent('processControl', options)
}

export function resolveBuddyPrivateDirectories(options: NativeHostPaths): string | undefined {
  return resolveNativeComponent('privateDirectories', options)
}

export function resolveBuddyShellSandbox(options: NativeHostPaths): string | undefined {
  return resolveNativeComponent('shellSandbox', options)
}

export function resolveBuddyImageTransformer(options: NativeHostPaths): string {
  return requireNativeComponent('imageTransform', options)
}

function requireNativeComponent(name: keyof typeof nativeHost.components, options: NativeHostPaths): string {
  const executable = resolveNativeComponent(name, options)
  if (!executable)
    throw new Error(`Missing required Buddy native component: ${name}`)
  return executable
}

function resolveNativeComponent(name: keyof typeof nativeHost.components, options: NativeHostPaths): string | undefined {
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const target = resolveBuddyTarget(platform, architecture)
  const component = nativeHost.components[name]
  if (!target.nativeComponents.includes(name))
    return undefined
  const executable = `${component.binary}${isWindows(platform) ? '.exe' : ''}`
  const paths = isWindows(platform) ? win32 : posix
  return options.isPackaged
    ? paths.join(options.resourcesPath, component.directory, executable)
    : paths.join(options.appPath, nativeHost.directory, target.rustTarget, 'release', executable)
}
