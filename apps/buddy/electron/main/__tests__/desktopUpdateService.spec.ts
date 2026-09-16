import { describe, expect, it } from 'vitest'
import { checkForDesktopUpdate } from '../desktopUpdateService'

describe('checkForDesktopUpdate', () => {
  it('reports a newer stable Lexora release without installing it', async () => {
    const fetchRelease = async () => new Response(JSON.stringify([
      {
        draft: false,
        html_url: 'https://github.com/useLexora/Lexora/releases/tag/web-v1.0.0',
        prerelease: false,
        tag_name: 'web-v1.0.0',
      },
      {
        draft: false,
        html_url: 'https://github.com/useLexora/Lexora/releases/tag/v0.2.0',
        prerelease: false,
        tag_name: 'v0.2.0',
      },
    ]), { status: 200 })

    await expect(checkForDesktopUpdate({
      currentVersion: '0.1.0',
      fetchRelease,
    })).resolves.toEqual({
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      releaseUrl: 'https://github.com/useLexora/Lexora/releases/tag/v0.2.0',
      status: 'update_available',
    })
  })

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
    })).resolves.toMatchObject({
      latestVersion: '0.1.0',
      status: 'up_to_date',
    })
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
