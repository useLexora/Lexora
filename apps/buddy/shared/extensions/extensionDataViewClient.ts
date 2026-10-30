import type { EventSubscriber, EventSubscription } from '../events/eventTypes'
import type { JsonValue } from '../workbench/workbenchState'
import type { ExtensionDataQuery, ExtensionDataSnapshot, ExtensionDataSource } from './extensionData'
import type { ExtensionDataEvents } from './extensionViewEvents'
import { copyEventSnapshot } from '../events/eventSnapshot'
import { extensionDataQuerySchema, extensionDataSnapshotSchema, projectExtensionDataSnapshot } from './extensionData'

type Request = (method: string, params?: JsonValue) => Promise<unknown>
export interface ExtensionDataViewClient {
  read: <Source extends ExtensionDataSource>(query: ExtensionDataQuery<Source>) => Promise<ExtensionDataSnapshot<Source>>
  observe: <Source extends ExtensionDataSource>(query: ExtensionDataQuery<Source>, listener: (snapshot: ExtensionDataSnapshot<Source>) => unknown) => EventSubscription
}

export function createExtensionDataViewClient(
  request: Request,
  events: EventSubscriber<ExtensionDataEvents>,
  signal: AbortSignal,
  sources: readonly ExtensionDataSource[] = [],
): ExtensionDataViewClient {
  const allowed = [...sources]
  const own = <Source extends ExtensionDataSource>(input: unknown, source: Source): ExtensionDataSnapshot<Source> => {
    const snapshot = extensionDataSnapshotSchema.parse(input)
    if (snapshot.source !== source)
      throw new Error('EXTENSION_DATA_SOURCE_MISMATCH')
    return copyEventSnapshot(projectExtensionDataSnapshot(snapshot, allowed)) as ExtensionDataSnapshot<Source>
  }
  return Object.freeze({
    async read<Source extends ExtensionDataSource>(query: ExtensionDataQuery<Source>) {
      signal.throwIfAborted()
      const parsed = extensionDataQuerySchema.parse(query)
      const value = await request('data.read', parsed)
      signal.throwIfAborted()
      return own(value, parsed.source as Source)
    },
    observe<Source extends ExtensionDataSource>(query: ExtensionDataQuery<Source>, listener: (snapshot: ExtensionDataSnapshot<Source>) => unknown): EventSubscription {
      const parsed = extensionDataQuerySchema.parse(query)
      if (signal.aborted)
        return { dispose() {} }
      const id = crypto.randomUUID()
      const lifetime = new AbortController()
      let disposed = false
      let registered = false
      const report = () => {
        if (!signal.aborted)
          console.error('EXTENSION_DATA_SUBSCRIPTION_FAILED')
      }
      const release = () => {
        if (!signal.aborted)
          void request('data.unobserve', { id }).catch(report)
      }
      const detach = () => {
        disposed = true
        lifetime.abort()
      }
      const dispose = () => {
        if (disposed)
          return
        detach()
        if (registered)
          release()
      }
      lifetime.signal.addEventListener('abort', () => signal.removeEventListener('abort', dispose), { once: true })
      events.on('data:changed', ({ data }) => {
        if (disposed || data.id !== id)
          return
        if (!data.snapshot) {
          detach()
          return
        }
        return listener(own(data.snapshot, parsed.source as Source))
      }, { signal: lifetime.signal })
      signal.addEventListener('abort', dispose, { once: true })
      void Promise.resolve().then(async () => {
        if (disposed)
          return
        await request('data.observe', { id, query: parsed })
        registered = true
        if (disposed)
          release()
      }).catch(() => {
        detach()
        release()
        report()
      })
      return { dispose }
    },
  })
}
