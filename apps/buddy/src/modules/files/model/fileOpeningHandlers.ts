import type { FileOpeningProvider } from '@buddy-shared/files/fileOpening'

export interface FileOpeningActions {
  document: () => void | Promise<void>
  browser: () => void | Promise<void>
  extension: () => void | Promise<void>
}

interface FileOpeningHandler {
  input: 'text' | 'resource'
  preview: 'markdown' | 'image' | 'media' | 'custom' | null
  open: (actions: FileOpeningActions) => void | Promise<void>
}

const document = (actions: FileOpeningActions) => actions.document()
const handlers: Readonly<Record<string, FileOpeningHandler>> = {
  image: { input: 'resource', preview: 'image', open: document },
  svg: { input: 'text', preview: 'image', open: document },
  markdown: { input: 'text', preview: 'markdown', open: document },
  media: { input: 'resource', preview: 'media', open: document },
  text: { input: 'text', preview: null, open: document },
  browser: { input: 'text', preview: null, open: actions => actions.browser() },
  extension: { input: 'text', preview: 'custom', open: actions => actions.extension() },
}

export function fileOpeningHandler(provider: FileOpeningProvider | null | undefined) {
  return provider ? handlers[provider.renderer] : undefined
}
