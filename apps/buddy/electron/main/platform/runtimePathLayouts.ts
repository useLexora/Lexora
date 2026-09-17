import type { BuddyRuntimeIdentity, BuddyRuntimePathOptions } from '../paths'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { validateWindowsFilePath } from '../../../platform/windows/filePath'

const { isAbsolute, join, normalize } = posix
const MAX_UNIX_SOCKET_PATH_BYTES = 100

export const runtimePathLayouts = {
  linux: { path: posix, resolveDirectories: resolveLinuxDirectories },
  darwin: { path: posix, resolveDirectories: resolveMacDirectories },
  win32: { path: { ...win32, normalize: validateWindowsFilePath }, resolveDirectories: resolveWindowsDirectories },
}

function resolveMacDirectories(identity: BuddyRuntimeIdentity, lexoraHome: string, options: BuddyRuntimePathOptions) {
  const library = join(options.userHome, 'Library')
  const runtimeRoot = identity.profile === 'test'
    ? join(lexoraHome, '.runtime')
    : join(library, 'Application Support', identity.namespace)
  const socketId = createHash('sha256').update(`${options.userHome}\0${lexoraHome}\0${identity.namespace}`).digest('hex').slice(0, 24)
  return {
    browserAdapterSocket: join('/private/tmp', `${identity.namespace}-${options.userId}-${socketId}`, 'browser.sock'),
    nativePetSocket: null,
    sessionData: identity.profile === 'test'
      ? join(runtimeRoot, 'cache', 'chromium')
      : join(library, 'Caches', identity.namespace, 'chromium'),
    stateRoot: join(runtimeRoot, 'state'),
    userData: identity.profile === 'stable'
      ? requireAbsolutePath(options.defaultUserData, 'Electron userData')
      : join(runtimeRoot, 'electron'),
  }
}

function resolveWindowsDirectories(identity: BuddyRuntimeIdentity, lexoraHome: string, options: BuddyRuntimePathOptions) {
  const localAppData = requireWindowsPath(
    options.localAppData ?? win32.join(options.userHome, 'AppData', 'Local'),
    'LocalAppData',
  )
  const runtimeRoot = identity.profile === 'test'
    ? win32.join(lexoraHome, '.runtime')
    : win32.join(localAppData, identity.appName)
  const pipeId = createHash('sha256')
    .update(`${options.userHome.toLowerCase()}\0${lexoraHome.toLowerCase()}\0${identity.namespace}`)
    .digest('hex')
    .slice(0, 24)
  return {
    browserAdapterSocket: `\\\\.\\pipe\\${identity.namespace}-browser-${pipeId}`,
    nativePetSocket: null,
    sessionData: win32.join(runtimeRoot, 'cache', 'chromium'),
    stateRoot: win32.join(runtimeRoot, 'state'),
    userData: identity.profile === 'stable'
      ? requireWindowsPath(options.defaultUserData, 'Electron userData')
      : win32.join(runtimeRoot, 'electron'),
  }
}

function resolveLinuxDirectories(identity: BuddyRuntimeIdentity, lexoraHome: string, options: BuddyRuntimePathOptions) {
  if (identity.profile === 'test') {
    const runtimeRoot = join(lexoraHome, '.runtime')
    const socketRoot = resolveTestSocketRoot(identity, lexoraHome, options)
    return {
      browserAdapterSocket: join(socketRoot, 'browser-adapter.sock'),
      nativePetSocket: join(socketRoot, 'native-pet.sock'),
      sessionData: join(runtimeRoot, 'cache', 'chromium'),
      stateRoot: join(runtimeRoot, 'state'),
      userData: join(runtimeRoot, 'electron'),
    }
  }

  const cacheHome = resolveAbsoluteXdgDirectory(
    options.xdgCacheHome,
    join(options.userHome, '.cache'),
  )
  const configHome = resolveAbsoluteXdgDirectory(
    options.xdgConfigHome,
    join(options.userHome, '.config'),
  )
  const stateHome = resolveAbsoluteXdgDirectory(
    options.xdgStateHome,
    join(options.userHome, '.local', 'state'),
  )
  const runtimeDirectory = resolveAbsoluteXdgDirectory(
    options.xdgRuntimeDirectory,
    join(options.temporaryDirectory, `${identity.namespace}-uid-${options.userId}`),
  )
  return {
    browserAdapterSocket: options.xdgRuntimeDirectory && isAbsolute(options.xdgRuntimeDirectory)
      ? join(runtimeDirectory, identity.namespace, 'browser-adapter.sock')
      : join(runtimeDirectory, 'browser-adapter.sock'),
    nativePetSocket: options.xdgRuntimeDirectory && isAbsolute(options.xdgRuntimeDirectory)
      ? join(runtimeDirectory, identity.namespace, 'native-pet.sock')
      : join(runtimeDirectory, 'native-pet.sock'),
    sessionData: join(cacheHome, identity.namespace, 'chromium'),
    stateRoot: join(stateHome, identity.namespace),
    userData: identity.profile === 'stable'
      ? requireAbsolutePath(options.defaultUserData, 'Electron userData')
      : join(configHome, identity.namespace, 'electron'),
  }
}

function resolveTestSocketRoot(
  identity: BuddyRuntimeIdentity,
  lexoraHome: string,
  options: BuddyRuntimePathOptions,
): string {
  const localRuntimeRoot = join(lexoraHome, '.runtime')
  const longestSocketPath = join(localRuntimeRoot, 'browser-adapter.sock')
  if (Buffer.byteLength(longestSocketPath, 'utf8') <= MAX_UNIX_SOCKET_PATH_BYTES)
    return localRuntimeRoot
  const digest = createHash('sha256').update(lexoraHome).digest('hex').slice(0, 16)
  return join(
    requireAbsolutePath(options.temporaryDirectory, 'temporary directory'),
    `${identity.namespace}-${digest}`,
  )
}

function resolveAbsoluteXdgDirectory(value: string | undefined, fallback: string): string {
  return value && isAbsolute(value) ? normalize(value) : fallback
}

function requireAbsolutePath(value: string, name: string): string {
  if (!isAbsolute(value))
    throw new Error(`${name} must be an absolute path`)
  return normalize(value)
}

function requireWindowsPath(value: string, name: string): string {
  try {
    return validateWindowsFilePath(value)
  }
  catch (error) {
    throw new Error(`${name} must be an absolute Windows file path`, { cause: error })
  }
}
