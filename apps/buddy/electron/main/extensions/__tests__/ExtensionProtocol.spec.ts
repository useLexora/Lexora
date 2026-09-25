import type { Session } from 'electron'
import { rm } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { createStore, manifest, reviewPackage } from '../../../../platform/extensions/__tests__/fixtures'
import { ExtensionProtocol, extensionSchemePrivileges } from '../ExtensionProtocol'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it('serves verified package media with range semantics and invalidates disposed endpoints', async () => {
  const { root, store } = await createStore()
  roots.push(root)
  await store.install((await reviewPackage(root, store, manifest(), { 'clip.mp3': '0123456789' })).token)
  const protocol = new ExtensionProtocol(store)
  const endpoint = protocol.register(store.installed['tests.reader']!.current, 'view')
  let respond!: (request: Request) => Promise<Response>
  protocol.install({ protocol: { handle: (_scheme: string, handler: typeof respond) => {
    respond = handler
  } } } as unknown as Session, 'view')
  expect(extensionSchemePrivileges.privileges?.stream).toBe(true)
  const url = new URL('/__package/clip.mp3', endpoint.url)
  const part = await respond(new Request(url, { headers: { range: 'bytes=3-6' } }))
  expect(part.status).toBe(206)
  expect(part.headers.get('content-type')).toBe('audio/mpeg')
  expect(part.headers.get('content-length')).toBe('4')
  expect(await part.text()).toBe('3456')
  expect((await respond(new Request(url, { headers: { range: 'bytes=99-' } }))).status).toBe(416)
  const head = await respond(new Request(url, { method: 'HEAD' }))
  expect(head.headers.get('content-length')).toBe('10')
  expect(await head.text()).toBe('')
  endpoint.dispose()
  expect((await respond(new Request(url))).status).toBe(403)
})
