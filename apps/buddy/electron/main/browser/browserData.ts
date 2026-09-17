import type { Session } from 'electron'
import type { BrowserClearDataInput, BrowserDataSummary } from '../../../shared/browser/browserData'

export async function readBrowserDataSummary(sessions: Session[]): Promise<BrowserDataSummary> {
  const summaries = await Promise.all(sessions.map(async session => ({
    cacheBytes: await session.getCacheSize(),
    cookies: await session.cookies.get({}),
  })))
  return {
    cacheBytes: summaries.reduce((total, item) => total + item.cacheBytes, 0),
    cookieSiteCount: new Set(summaries.flatMap(item => item.cookies.flatMap(cookie => cookie.domain ? [cookie.domain.replace(/^\./, '')] : []))).size,
  }
}

export async function clearBrowserData(sessions: Session[], input: BrowserClearDataInput): Promise<void> {
  const operations = sessions.flatMap(session => [
    ...(input.siteData
      ? [
          () => session.clearData({ dataTypes: ['cookies', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL', 'backgroundFetch'] }),
          () => session.clearAuthCache(),
        ]
      : []),
    ...(input.cache ? [() => session.clearCache(), () => session.clearStorageData({ storages: ['cachestorage'] })] : []),
  ])
  const results = await Promise.allSettled(operations.map(async operation => operation()))
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length)
    throw new AggregateError(failures.map(result => result.reason), 'Browser data clearing failed')
}
