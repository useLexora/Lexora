import { expect, it } from 'vitest'
import { waitsForExtensionIo } from '../extensionRequestLifecycle'

it.each(['resources.readBytes', 'resources.scanDirectory', 'taskCleanup.delete'])('does not impose a short view RPC deadline on %s', (method) => {
  expect(waitsForExtensionIo(method)).toBe(true)
})

it('keeps ordinary view RPCs outside the long-I/O policy', () => {
  expect(waitsForExtensionIo('storage.get')).toBe(false)
  expect(waitsForExtensionIo('unknown.method')).toBe(false)
})
