import type { NetworkAuthorizer } from '../../../../shared/network/networkAuthorization'
import { describe, expect, it } from 'vitest'
import { createFixture } from './browserHostFixture'

interface Request { webContentsId?: number, resourceType: string, url: string, uploadData?: Array<{ file?: string, blobUUID?: string, bytes?: Uint8Array }>, responseHeaders?: Record<string, string[]> }

function fixture() {
  const fixture = createFixture()
  const state = fixture.host.ensureSession('network-test')
  const requests = fixture.webContents.session.webRequest
  const before = requests.onBeforeRequest.mock.calls[0]![1] as (details: Request, callback: (result: { cancel: boolean }) => void) => void
  const headers = requests.onHeadersReceived.mock.calls[0]![0] as typeof before
  const request = (url: string, extra: Partial<Request> = {}) => new Promise<{ cancel: boolean }>(resolve => before({ resourceType: 'mainFrame', webContentsId: fixture.webContents.id, url, ...extra }, resolve))
  const response = (url: string, responseHeaders: Record<string, string[]>) => new Promise<{ cancel: boolean }>(resolve => headers({ resourceType: 'mainFrame', webContentsId: fixture.webContents.id, url, responseHeaders }, resolve))
  const run = <T>(authorize: NetworkAuthorizer, operation: () => Promise<T>, signal?: AbortSignal) => fixture.host.withNetworkAuthorization(state.sessionId, authorize, signal, operation)
  return { ...fixture, state, request, response, run }
}

describe('browser actual request authorization', () => {
  it('authorizes each redirected or subresource target before allowing Chromium to connect', async () => {
    const f = fixture()
    const targets: string[] = []
    try {
      await expect(f.run(async (url) => {
        targets.push(url)
        if (url.includes('blocked'))
          throw new Error('denied')
      }, async () => {
        expect(await f.request('https://allowed.example/start')).toEqual({ cancel: false })
        expect(await f.request('https://blocked.example/redirect')).toEqual({ cancel: true })
        expect(await f.request('https://blocked.example/script', { resourceType: 'script' })).toEqual({ cancel: true })
      })).rejects.toThrow('denied')
      expect(targets).toEqual(['https://allowed.example/start', 'https://blocked.example/redirect', 'https://blocked.example/script'])
      expect(await f.request('https://allowed.example/late')).toEqual({ cancel: true })
    }
    finally { f.host.dispose() }
  })

  it('blocks file uploads and gates download response headers independently from access', async () => {
    const f = fixture()
    const operations: string[] = []
    try {
      await expect(f.run(async (_url, operation) => {
        operations.push(operation!)
        if (operation !== 'access')
          throw new Error('file transfer denied')
      }, async () => {
        expect(await f.request('https://example.com/upload', { uploadData: [{ file: '/private/file.txt' }] })).toEqual({ cancel: true })
        expect(await f.response('https://example.com/report', { 'Content-Type': ['application/pdf'] })).toEqual({ cancel: true })
      })).rejects.toThrow('file transfer denied')
      expect(operations).toEqual(['download'])
    }
    finally { f.host.dispose() }
  })

  it('never permits recognized file uploads, even with an allowing authorizer or manual control', async () => {
    const f = fixture()
    let approvals = 0
    const uploads = [
      [{ file: '/private/file.txt' }],
      [{ bytes: new TextEncoder().encode('Content-Disposition: form-data; name="file"; filename="file.txt"\r\n') }],
    ]
    try {
      for (const uploadData of uploads) {
        expect(await f.request('https://manual.example/upload', { uploadData })).toEqual({ cancel: true })
        await f.run(async () => {
          approvals++
        }, async () => {
          expect(await f.request('https://agent.example/upload', { uploadData })).toEqual({ cancel: true })
        })
        f.host.takeControl(f.state.sessionId)
      }
      expect(approvals).toBe(0)
      for (const uploadData of [
        [{ bytes: new TextEncoder().encode('name=value') }],
        [{ bytes: new TextEncoder().encode('{"name":"value"}') }],
        [{ blobUUID: 'json-request-body' }],
        [{ bytes: new TextEncoder().encode('Content-Disposition: form-data; name="message"\r\n') }],
      ]) {
        expect(await f.request('https://manual.example/form', { uploadData })).toEqual({ cancel: false })
      }
    }
    finally { f.host.dispose() }
  })

  it('does not prompt for manual browsing and clears expired agent ownership only on explicit human takeover', async () => {
    const f = fixture()
    let approvals = 0
    try {
      expect(await f.request('https://manual.example/')).toEqual({ cancel: false })
      await f.run(async () => {
        approvals++
      }, () => f.request('https://agent.example/'))
      expect(await f.request('https://agent.example/late')).toEqual({ cancel: true })
      f.host.takeControl(f.state.sessionId)
      expect(await f.request('https://manual.example/next')).toEqual({ cancel: false })
      expect(approvals).toBe(1)
      expect(await f.request('https://worker.example/', { webContentsId: -1 })).toEqual({ cancel: true })
    }
    finally { f.host.dispose() }
  })

  it('rejects a late grant after cancellation and never releases the pending network request', async () => {
    const f = fixture()
    const started = Promise.withResolvers<void>()
    const decision = Promise.withResolvers<void>()
    const controller = new AbortController()
    try {
      const running = f.run(async () => {
        started.resolve()
        await decision.promise
      }, async () => {
        expect(await f.request('https://example.com/')).toEqual({ cancel: true })
      }, controller.signal)
      const rejected = expect(running).rejects.toThrow()
      await started.promise
      controller.abort()
      decision.resolve()
      await rejected
      expect(f.webContents.stop).toHaveBeenCalled()
    }
    finally { f.host.dispose() }
  })

  it('does not restore manual network access when runtime control is released', async () => {
    const f = fixture()
    try {
      const lease = f.host.acquireControl({ sessionId: f.state.sessionId, pageId: f.state.pageId })
      f.host.releaseControl(lease)
      expect(f.host.getState(f.state.sessionId).controller).toBe('human')
      expect(await f.request('https://agent.example/late')).toEqual({ cancel: true })
      expect(await f.response('https://agent.example/late.pdf', { 'content-type': ['application/pdf'] })).toEqual({ cancel: true })
      f.host.takeControl(f.state.sessionId)
      expect(await f.request('https://manual.example/')).toEqual({ cancel: false })
    }
    finally { f.host.dispose() }
  })

  it('rejects a pending agent grant after explicit human takeover', async () => {
    const f = fixture()
    const started = Promise.withResolvers<void>()
    const decision = Promise.withResolvers<void>()
    try {
      const running = f.run(async () => {
        started.resolve()
        await decision.promise
      }, async () => {
        expect(await f.request('https://agent.example/')).toEqual({ cancel: true })
      })
      const rejected = expect(running).rejects.toThrow()
      await started.promise
      f.host.takeControl(f.state.sessionId)
      expect(await f.request('https://manual.example/')).toEqual({ cancel: false })
      decision.resolve()
      await rejected
      expect(await f.request('https://manual.example/next')).toEqual({ cancel: false })
    }
    finally { f.host.dispose() }
  })

  it('keeps native file selection and browser download saving disabled', async () => {
    const f = fixture()
    try {
      await f.host.navigate(f.state.sessionId, 'https://example.com')
      expect(f.webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.setInterceptFileChooserDialog', { cancel: true, enabled: true })
      let prevented = false
      f.webContents.session.emit('will-download', { preventDefault() {
        prevented = true
      } }, {}, f.webContents)
      expect(prevented).toBe(true)
    }
    finally { f.host.dispose() }
  })
})
