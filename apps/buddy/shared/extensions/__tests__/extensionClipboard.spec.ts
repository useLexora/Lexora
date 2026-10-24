import { expect, it } from 'vitest'
import { parseExtensionRequestParams } from '../extensionApi'
import { EXTENSION_CLIPBOARD_BYTES_LIMIT } from '../extensionClipboard'
import { addedExtensionPermissions, extensionPermissionsSchema } from '../extensionManifest'

it('requires independently reviewed clipboard permissions and keeps previous manifests denied by default', () => {
  const previous = extensionPermissionsSchema.parse({})
  expect(previous).toMatchObject({ clipboardRead: false, clipboardWrite: false })
  const read = extensionPermissionsSchema.parse({ clipboardRead: true })
  const both = extensionPermissionsSchema.parse({ clipboardRead: true, clipboardWrite: true })
  expect(addedExtensionPermissions(previous, read)).toEqual(['clipboardRead'])
  expect(addedExtensionPermissions(read, both)).toEqual(['clipboardWrite'])
  expect(addedExtensionPermissions(both, read)).toEqual([])
})
it('gives clipboard writes their own combined UTF-8 budget without widening ordinary requests', () => {
  const text = '文'.repeat(Math.floor(EXTENSION_CLIPBOARD_BYTES_LIMIT / 3))
  expect(parseExtensionRequestParams('clipboard.write', { text })).toEqual({ text })
  expect(() => parseExtensionRequestParams('clipboard.write', { text, html: 'xx' })).toThrow()
  expect(() => parseExtensionRequestParams('view.setState', { text })).toThrow()
  expect(parseExtensionRequestParams('clipboard.write', { text: '', html: '' })).toEqual({ text: '', html: '' })
})
