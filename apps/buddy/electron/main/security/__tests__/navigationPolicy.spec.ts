import { describe, expect, it } from 'vitest'
import {
  isAllowedExternalUrl,
  isAllowedRendererNavigation,
  resolveDevelopmentRendererUrl,
} from '../navigationPolicy'

describe('electron navigation policy', () => {
  it('allows only the exact renderer document and its hash changes', () => {
    const rendererUrl = 'http://127.0.0.1:1420/chat'

    expect(isAllowedRendererNavigation(rendererUrl, rendererUrl)).toBe(true)
    expect(isAllowedRendererNavigation(`${rendererUrl}#settings`, rendererUrl)).toBe(true)
    expect(isAllowedRendererNavigation('http://127.0.0.1:1420/panel', rendererUrl)).toBe(false)
    expect(isAllowedRendererNavigation('http://localhost:1420/chat', rendererUrl)).toBe(false)
    expect(isAllowedRendererNavigation('https://example.com/', rendererUrl)).toBe(false)
  })

  it('supports the exact packaged app URL without granting file access', () => {
    const rendererUrl = 'lexora-app://renderer/index.html'

    expect(isAllowedRendererNavigation(`${rendererUrl}#chat`, rendererUrl)).toBe(true)
    expect(isAllowedRendererNavigation('lexora-app://renderer/settings.html', rendererUrl)).toBe(false)
    expect(isAllowedRendererNavigation('file:///etc/passwd', rendererUrl)).toBe(false)
  })

  it.each([
    'https://example.com/',
    'http://example.com/docs',
    'http://192.168.1.12:8765/',
    'http://dev.example.test:3000/',
    'http://127.0.0.1:8765',
    'http://localhost:8765/project?view=main#home',
    'http://[::1]:8765/',
  ])('opens HTTP and HTTPS links externally regardless of hostname (%s)', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(true)
  })

  it.each([
    'http://',
    '//example.com/',
    'httpx://example.com/',
    'ftp://example.com/',
    'mailto:someone@example.com',
    'javascript:alert(1)',
    'file:///tmp/secret',
    'data:text/html,<h1>unsafe</h1>',
    'lexora-app://renderer/index.html',
    'not a URL',
  ])('rejects malformed URLs and non-web protocols (%s)', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false)
  })

  it('accepts a loopback development renderer only in unpackaged builds', () => {
    expect(resolveDevelopmentRendererUrl('http://127.0.0.1:5173', false))
      .toBe('http://127.0.0.1:5173/')
    expect(resolveDevelopmentRendererUrl('http://localhost:5173', false))
      .toBe('http://localhost:5173/')
    expect(resolveDevelopmentRendererUrl('https://example.com', false)).toBeNull()
    expect(resolveDevelopmentRendererUrl('http://127.0.0.1:5173', true)).toBeNull()
  })
})
