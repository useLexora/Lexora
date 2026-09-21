import type { Api, Model } from '@earendil-works/pi-ai'
import type { CacheWarmingStatus } from '@earendil-works/pi-coding-agent'
import type { LocalCacheWarmingStatus } from '../../../../shared/runs/conversationStatusApi'
import type { RuntimePreferences } from '../../../../shared/runtime/runtimePreferences'

export function getBuddyCacheWarmingStatus(input: {
  mode: RuntimePreferences['cacheWarming']
  model: Model<Api> | undefined
  active: boolean
  status: CacheWarmingStatus | undefined
}): LocalCacheWarmingStatus {
  if (input.mode === 'off')
    return 'off'
  if (input.model && !input.model.promptCache)
    return 'unsupported'
  if (!input.active)
    return 'idle'
  const status = input.status
  if (!status)
    return 'waiting'
  if (status.state !== 'inactive')
    return status.state
  switch (status.reason) {
    case 'waiting for first request': return 'waiting'
    case 'cache lifetime unavailable':
    case 'request cannot be replayed safely':
    case 'request disabled prompt caching': return 'unsupported'
    case 'cache economics unavailable': return 'unavailable'
    case 'cache refresh deadline missed': return 'expired'
    case 'expected savings below threshold': return 'uneconomic'
    default: return 'stopped'
  }
}
