// View-side RPC completion policy only. Host responsiveness is monitored by
// an independent heartbeat, never by pausing deadlines for this method list.
const ioMethods = new Set([
  'inference.credentials.set',
  'inference.credentials.remove',
  'inference.resources.prepare',
  'inference.bind',
  'inference.stop',
  'network.get',
  'network.download',
  'resources.importFile',
  'resources.readBytes',
  'resources.scanDirectory',
  'resources.hash',
  'resources.beginCreate',
  'resources.writeChunk',
  'resources.commitSave',
  'resources.cancelSave',
  'themes.request',
  'taskCleanup.delete',
  'documents.pick',
  'documents.open',
  'documents.resume',
  'documents.list',
  'documents.readBytes',
  'documents.beginWrite',
  'documents.writeChunk',
  'documents.commitWrite',
  'documents.cancelWrite',
  'documents.status',
  'documents.discardRecovery',
  'documents.forget',
  'documents.reveal',
])

export function waitsForExtensionIo(method: string): boolean {
  return ioMethods.has(method)
}
