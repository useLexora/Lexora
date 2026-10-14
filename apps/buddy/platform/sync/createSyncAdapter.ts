import type { SyncConnection } from '../../shared/sync/syncApi'
import type { SyncAdapter, SyncTransport } from './SyncAdapter'
import { S3Adapter } from './S3Adapter'
import { WebDavAdapter } from './WebDavAdapter'

export function createSyncAdapter(connection: SyncConnection, secret: string, transport: SyncTransport): SyncAdapter {
  switch (connection.adapter) {
    case 'webdav': return new WebDavAdapter(connection, secret, transport)
    case 's3': return new S3Adapter(connection, secret, transport)
  }
}
