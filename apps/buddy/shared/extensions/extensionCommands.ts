export function extensionCommandNamespace(id: string): string {
  return id.slice(id.indexOf('.') + 1)
}
