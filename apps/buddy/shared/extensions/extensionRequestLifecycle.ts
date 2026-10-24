const ioMethods = new Set([
  'network.get',
  'network.download',
  'resources.importFile',
  'resources.beginCreate',
  'resources.writeChunk',
  'resources.commitSave',
  'resources.cancelSave',
  'themes.request',
])

export function waitsForExtensionIo(method: string): boolean {
  return ioMethods.has(method)
}
