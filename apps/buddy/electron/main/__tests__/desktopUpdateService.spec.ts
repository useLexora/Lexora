import { describe, expect, it } from 'vitest'
import { checkForDesktopUpdate } from '../desktopUpdateService'

describe('checkForDesktopUpdate', () => {
  it('reports the current version only after a valid release response', async () => {
    const fetchRelease = async () => new Response(JSON.stringify([{
      draft: false,
      html_url: 'https://github.com/useLexora/Lexora/releases/tag/v0.1.0',
      prerelease: false,
      tag_name: 'v0.1.0',
    }]), { status: 200 })

    await expect(checkForDesktopUpdate({
      currentVersion: '0.1.0',
      fetchRelease,
    })).resolves.toEqual({
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
      releaseUrl: 'https://github.com/useLexora/Lexora/releases/tag/v0.1.0',
      releaseNotes: '',
      status: 'up_to_date',
    })
  })

  it('selects the highest trusted stable version and preserves the complete release notes', async () => {
    const release = (version: string, fields = {}) => ({ draft: false, prerelease: false, tag_name: `v${version}`, html_url: `https://github.com/useLexora/Lexora/releases/tag/v${version}`, ...fields })
    const result = await checkForDesktopUpdate({
      currentVersion: '1.2.0',
      fetchRelease: async () => new Response(JSON.stringify([
        release('1.9.0'),
        release('1.10.0', { body: 'x'.repeat(20_000) }),
        release('2.0.0', { tag_name: 'web-v2.0.0', html_url: 'https://github.com/useLexora/Lexora/releases/tag/web-v2.0.0' }),
        release('9.0.0', { html_url: 'https://example.invalid/download' }),
        release('8.0.0', { draft: true }),
        release('7.0.0', { prerelease: true }),
        release('6.0.0-beta'),
      ])),
    })
    expect(result).toEqual({
      currentVersion: '1.2.0',
      latestVersion: '1.10.0',
      releaseUrl: 'https://github.com/useLexora/Lexora/releases/tag/v1.10.0',
      releaseNotes: 'x'.repeat(20_000),
      status: 'update_available',
    })
  })

  it('returns a stable failure for an oversized response or an aborted request', async () => {
    await expect(checkForDesktopUpdate({
      currentVersion: '1.0.0',
      fetchRelease: async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)),
    })).rejects.toMatchObject({ code: 'UPDATE_CHECK_FAILED' })
    await expect(checkForDesktopUpdate({
      currentVersion: '1.0.0',
      signal: AbortSignal.abort(),
      fetchRelease: async (_url, init) => {
        init?.signal?.throwIfAborted()
        return new Response('[]')
      },
    })).rejects.toMatchObject({ code: 'UPDATE_CHECK_FAILED' })
  })

  it('returns a stable failure for unavailable or invalid release data', async () => {
    await expect(checkForDesktopUpdate({
      currentVersion: '0.1.0',
      fetchRelease: () => Promise.resolve(new Response('', { status: 503 })),
    })).rejects.toMatchObject({ code: 'UPDATE_CHECK_FAILED' })

    await expect(checkForDesktopUpdate({
      currentVersion: '0.1.0',
      fetchRelease: () => Promise.resolve(new Response(JSON.stringify([{
        draft: false,
        html_url: 'https://example.com/release',
        prerelease: false,
        tag_name: 'next',
      }]), { status: 200 })),
    })).rejects.toMatchObject({ code: 'UPDATE_CHECK_FAILED' })
  })
})
