import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import { documentFindLimit } from './documentFind'

export interface MonacoFindDecoration {
  collection: Monaco.editor.IEditorDecorationsCollection | null
  count: number
  capped: boolean
}

// The desktop Monaco build does not register the find widget. A custom bar drives
// model.findMatches so source and edit stay inside the narrow file pane.
export function renderMonacoFind(
  editor: Monaco.editor.IStandaloneCodeEditor,
  query: string,
  activeIndex: number,
  reveal: boolean,
  collection: Monaco.editor.IEditorDecorationsCollection | null,
): MonacoFindDecoration {
  const model = editor.getModel()
  const needle = query.trim()
  if (!model || !needle) {
    collection?.clear()
    return { collection, count: 0, capped: false }
  }
  const found = model.findMatches(needle, false, false, false, null, false, documentFindLimit + 1)
  const capped = found.length > documentFindLimit
  const matches = capped ? found.slice(0, documentFindLimit) : found
  const index = matches.length ? Math.min(activeIndex, matches.length - 1) : 0
  const next = collection ?? editor.createDecorationsCollection([])
  next.set(matches.map((match, item) => ({
    range: match.range,
    options: { inlineClassName: item === index ? 'document-find-current' : 'document-find-match' },
  })))
  const current = matches[index]
  if (reveal && current)
    editor.revealRangeInCenter(current.range)
  return { collection: next, count: matches.length, capped }
}
