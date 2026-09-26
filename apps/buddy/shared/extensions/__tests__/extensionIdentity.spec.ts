import { describe, expect, it } from 'vitest'
import { createExtensionId, extensionAuthorSchema } from '../extensionIdentity'
import { extensionManifestSchema } from '../extensionManifest'

const manifest = { schemaVersion: 1, format: 'source', apiVersion: 3, name: '音乐', version: '1.0.0', engines: { lexora: '>=0.9.0 <1' }, contributes: {} }

describe('plugin identity and signature', () => {
  it('accepts shared display names while preserving independent IDs and legacy manifests', () => {
    const first = extensionManifestSchema.parse({ ...manifest, id: createExtensionId('music'), author: '山雨海' })
    const second = extensionManifestSchema.parse({ ...manifest, id: createExtensionId('music'), author: '山雨海' })
    expect(first.id).not.toBe(second.id)
    expect(extensionManifestSchema.parse({ ...first, author: '新的署名', name: '新名称' }).id).toBe(first.id)
    expect(extensionManifestSchema.parse({ ...manifest, id: 'local.music' }).author).toBeUndefined()
  })

  it.each(['山雨海', 'Équipe 🎨', '👨‍👩‍👧‍👦'.repeat(80), 'e\u0301'.repeat(80), ''])('preserves the Unicode signature %s', (author) => {
    expect(extensionAuthorSchema.parse(author)).toBe(author)
  })

  it.each(['名'.repeat(81), 'first\nsecond', 'name\u0000', 'name\u202E', '  name'])('rejects invalid signatures without truncation', (author) => {
    expect(extensionAuthorSchema.safeParse(author).success).toBe(false)
  })
})
