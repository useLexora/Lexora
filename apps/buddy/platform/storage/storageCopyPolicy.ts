export function chromiumTransientEntry(name: string): boolean {
  return /^(?:SingletonLock|SingletonSocket|SingletonCookie|DevToolsActivePort|lockfile)$/.test(name)
}

export function chromiumCacheEntry(name: string): boolean {
  return /^(?:Cache|Code Cache|GPUCache|GPUPersistentCache|DawnWebGPUCache|DawnGraphiteCache|ShaderCache|GrShaderCache)$/.test(name)
}

export function chromiumRebuildable(path: string): boolean {
  const entry = /^(?:Partitions\/[^/]+\/)?([^/]+)$/.exec(path)?.[1]
  return entry !== undefined && (chromiumTransientEntry(entry) || chromiumCacheEntry(entry) || /^(?:Crashpad|Crash Reports)$/.test(entry))
}

export function legacyStorageExcluded(destination: string, path: string): boolean {
  if (destination === 'device/electron' || destination === 'device/chromium')
    return chromiumRebuildable(path)
  return destination === 'device/state' && /^(?:logs|crashes)$/.test(path)
}

export function migrationStorageExcluded(path: string): boolean {
  if (/^(?:cache|logs|device\/crashes|(?:device|\.runtime)\/state\/(?:logs|crashes))$/.test(path))
    return true
  const browserPath = /^(?:device\/(?:electron|chromium)|\.runtime\/(?:electron|cache\/chromium))\/(.+)$/.exec(path)?.[1]
  return browserPath !== undefined && chromiumRebuildable(browserPath)
}
