import { afterEach, describe, expect, it, vi } from 'vitest'
import { translateBuddy } from '@/i18n/buddyI18n'
import { diagnoseFilePreviewError, resolveFileErrorKey } from '../filePreviewError'
import { resolveLocalChatErrorMessage } from '../localChatError'

const errors = [
  ['FILE_NOT_FOUND', 404, 'desktop.context.previewFileMissing'],
  ['FILE_ACCESS_DENIED', 403, 'desktop.context.previewAccessDenied'],
  ['FILE_TOO_LARGE', 413, 'desktop.context.previewTooLarge'],
  ['FILE_UNSUPPORTED', 415, 'desktop.context.previewUnsupported'],
  ['FILE_CHANGED', 409, 'desktop.context.previewFileChanged'],
  ['FILE_READ_FAILED', 500, 'desktop.context.previewLoadFailed'],
] as const
const fallback = 'desktop.context.previewLoadFailed'
const src = 'lexora-artifact://preview/example?v=1'
const signal = () => new AbortController().signal

afterEach(() => vi.unstubAllGlobals())

describe('file preview errors', () => {
  it.each(errors)('classifies structured and serialized %s without exposing private details', (code, _status, key) => {
    expect(resolveFileErrorKey({ code, message: '/private/file' })).toBe(key)
    expect(resolveFileErrorKey(new Error(`Error invoking remote method: LEXORA_LOCAL_CHAT_ERROR:${code}:0`))).toBe(key)
  })

  it.each(errors.filter(([code]) => code !== 'FILE_NOT_FOUND' && code !== 'FILE_UNSUPPORTED'))('localizes the new file error %s in both languages', (code, _status, key) => {
    for (const language of ['zh-CN', 'en-US'] as const)
      expect(resolveLocalChatErrorMessage(new Error(`LEXORA_LOCAL_CHAT_ERROR:${code}:0`), language)).toBe(translateBuddy(language, key))
  })

  it.each(errors)('classifies %s from a response header or HTTP status', async (code, status, key) => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 500, headers: { 'x-lexora-error-code': code } })).mockResolvedValueOnce(new Response(null, { status }))
    vi.stubGlobal('fetch', fetch)
    expect(await diagnoseFilePreviewError(src, signal(), fallback)).toBe(key)
    expect(await diagnoseFilePreviewError(src, signal(), fallback)).toBe(key)
    expect(fetch.mock.calls[0]).toEqual([src, { method: 'HEAD', signal: expect.any(AbortSignal), redirect: 'error', cache: 'no-store' }])
  })

  it('does not mistake a decode failure for a missing file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
    expect(await diagnoseFilePreviewError(src, signal(), fallback)).toBe('desktop.context.previewDecodeFailed')
  })

  it.each(['https://example.com/file', 'file:///private/file', 'lexora-artifact://other/file', 'lexora-artifact://user@preview/file', 'not a URL'])('does not probe uncontrolled URL %s', async (url) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await diagnoseFilePreviewError(url, signal(), fallback)).toBe(fallback)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves the caller fallback for unknown errors and transport failures', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 502, headers: { 'x-lexora-error-code': 'UNKNOWN' } })).mockRejectedValueOnce(new Error('/private/file'))
    vi.stubGlobal('fetch', fetch)
    expect(resolveFileErrorKey(new Error('/private/file'))).toBeNull()
    expect(await diagnoseFilePreviewError(src, signal(), 'desktop.context.mediaPlaybackFailed')).toBe('desktop.context.mediaPlaybackFailed')
    expect(await diagnoseFilePreviewError(src, signal(), fallback)).toBe(fallback)
  })
})
