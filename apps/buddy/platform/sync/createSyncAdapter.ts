import type { SyncConnection } from '../../shared/sync/syncApi'
import type { SyncAdapter, SyncTransport } from './SyncAdapter'
import { WebDavAdapter } from './WebDavAdapter'

export async function createSyncAdapter(connection: SyncConnection, secret: string, transport: SyncTransport): Promise<SyncAdapter> {
  switch (connection.adapter) {
    case 'webdav': return new WebDavAdapter(connection, secret, transport)
    case 's3': {
      const { S3Adapter } = await import('./S3Adapter')
      return new S3Adapter(connection, secret, transport)
    }
  }
}
