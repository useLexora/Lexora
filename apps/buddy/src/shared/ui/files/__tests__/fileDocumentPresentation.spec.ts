import { describe, expect, it } from 'vitest'
import { fileDocumentModes, isMarkdownFile, resolveFileDocumentMode } from '../fileDocumentPresentation'

describe('document capabilities', () => {
  it.each([
    [{ preview: true, source: true, edit: true }, ['preview', 'source', 'edit']],
    [{ preview: false, source: true, edit: true }, ['source', 'edit']],
    [{ preview: true, source: true, edit: false }, ['preview', 'source']],
    [{ preview: true, source: false, edit: false }, ['preview']],
    [{ preview: false, source: false, edit: false }, []],
  ])('exposes only supported modes for %j', (capabilities, expected) => {
    expect(fileDocumentModes(capabilities)).toEqual(expected)
  })

  it('preserves an available mode and falls back safely when editing is unavailable', () => {
    expect(resolveFileDocumentMode('source', ['preview', 'source'])).toBe('source')
    expect(resolveFileDocumentMode('edit', ['preview', 'source'])).toBe('preview')
    expect(resolveFileDocumentMode(undefined, ['source', 'edit'])).toBe('source')
    expect(resolveFileDocumentMode('edit', [])).toBeNull()
  })

  it.each(['README.MD', 'notes.markdown', 'notes.mdown'])('recognizes Markdown consistently for %s', (name) => {
    expect(isMarkdownFile(name)).toBe(true)
    expect(isMarkdownFile(`${name}.txt`)).toBe(false)
  })
})
