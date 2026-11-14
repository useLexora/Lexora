import { resolve } from 'node:path'

interface Writes {
  blocked: boolean
  pending: Set<Promise<unknown>>
}
const profiles = new Map<string, Writes>()

function state(root: string): Writes {
  const key = resolve(root)
  let current = profiles.get(key)
  if (!current) {
    current = { blocked: false, pending: new Set() }
    profiles.set(key, current)
  }
  return current
}

function release(root: string, current: Writes) {
  if (!current.blocked && !current.pending.size && profiles.get(resolve(root)) === current)
    profiles.delete(resolve(root))
}

export function runProfileWrite<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const current = state(root)
  if (current.blocked)
    return Promise.reject(new Error('PROFILE_STORAGE_MAINTENANCE'))
  const deferred = Promise.withResolvers<T>()
  const pending = deferred.promise.finally(() => {
    current.pending.delete(pending)
    release(root, current)
  })
  current.pending.add(pending)
  try {
    deferred.resolve(operation())
  }
  catch (error) {
    deferred.reject(error)
  }
  return pending
}

export async function withProfileWritesStopped<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const current = state(root)
  if (current.blocked)
    throw new Error('PROFILE_STORAGE_MAINTENANCE')
  current.blocked = true
  try {
    await Promise.allSettled([...current.pending])
    return await operation()
  }
  finally {
    current.blocked = false
    release(root, current)
  }
}
