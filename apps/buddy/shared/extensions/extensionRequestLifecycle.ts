const ioMethods = new Set([
  'network.get',
  'network.download',
  'resources.importFile',
  'resources.beginCreate',
  'resources.writeChunk',
  'resources.commitSave',
  'resources.cancelSave',
  'themes.request',
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
