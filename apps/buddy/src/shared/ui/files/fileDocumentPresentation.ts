export type FileDocumentMode = 'preview' | 'source' | 'edit'

export function isMarkdownFile(name: string): boolean {
  return /\.(?:md|mdown|markdown)$/i.test(name)
}

export function fileDocumentModes(capabilities: { preview: boolean, source: boolean, edit: boolean }): FileDocumentMode[] {
  return (['preview', 'source', 'edit'] as const).filter(mode => capabilities[mode])
}

export function resolveFileDocumentMode(value: unknown, modes: readonly FileDocumentMode[]): FileDocumentMode | null {
  return modes.find(mode => mode === value) ?? modes[0] ?? null
}
