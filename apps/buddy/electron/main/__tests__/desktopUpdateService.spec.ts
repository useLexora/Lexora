import { describe, expect, it } from 'vitest'
import { compareDesktopVersions, desktopVersionSchema } from '../../shared/desktopUpdates'
import { RELEASES_API_URL } from '../../shared/productLinks'
import { checkForDesktopUpdate } from '../desktopUpdateService'

function release(version: string, fields = {}) {
  return { draft: false, prerelease: version.includes('-beta.'), tag_name: `v${version}`, html_url: `https://github.com/useLexora/Lexora/releases/tag/v${version}`, ...fields }
}

describe('checkForDesktopUpdate', () => {
  it('accepts only stable and numbered Beta versions and compares Beta identifiers numerically', () => {
    const versions = ['1.2.0', '1.2.0-beta.10', '1.2.0-beta.2', '1.1.9']
    expect(versions.sort(compareDesktopVersions)).toEqual(['1.1.9', '1.2.0-beta.2', '1.2.0-beta.10', '1.2.0'])
    for (const version of ['1.2.0-beta', '1.2.0-beta.0', '1.2.0-beta.01', '01.2.0', '1.2.0-alpha.1', '1.2.0+build', '1.2.0\n', '1.2.0-beta.1\r\n'])
      expect(desktopVersionSchema.safeParse(version).success).toBe(false)
  })

  it.each([
    { channel: 'stable' as const, expected: '1.10.0', notes: 'x'.repeat(20_000) },
    { channel: 'beta' as const, expected: '2.0.0-beta.10', notes: '' },
  ])('selects the highest trusted version for $channel and preserves complete release notes', async ({ channel, expected, notes }) => {
    const result = await checkForDesktopUpdate({
      currentVersion: '1.0.0',
      channel,
      fetchRelease: async () => new Response(JSON.stringify([
        release('2.0.0-beta.2'),
        release('1.9.0'),
        release('1.10.0', { body: 'x'.repeat(20_000) }),
        release('2.0.0-beta.10'),
        release('9.0.0', { prerelease: true }),
        release('9.0.0-beta.1', { prerelease: false }),
        release('9.0.0-beta.2', { draft: true }),
        release('9.0.0-beta.3', { html_url: release('1.10.0').html_url }),
        release('2.0.0', { tag_name: 'web-v2.0.0', html_url: 'https://github.com/useLexora/Lexora/releases/tag/web-v2.0.0' }),
        release('9.0.0', { html_url: 'https://example.invalid/download' }),
        release('6.0.0-beta'),
      ])),
    })
    expect(result).toEqual({
      currentVersion: '1.0.0',
      latestVersion: expected,
      releaseUrl: `https://github.com/useLexora/Lexora/releases/tag/v${expected}`,
      releaseNotes: notes,
      status: 'update_available',
    })
  })

  it('promotes Beta subscribers to stable without downgrading on a stable-channel switch', async () => {
    for (const currentVersion of ['1.1.0', '1.2.0-beta.10', '1.2.0']) {
      const result = await checkForDesktopUpdate({ currentVersion, channel: 'beta', fetchRelease: async () => new Response(JSON.stringify([release('1.2.0'), release('1.2.0-beta.11')])) })
      expect(result).toMatchObject({ latestVersion: '1.2.0', status: currentVersion === '1.2.0' ? 'up_to_date' : 'update_available' })
    }
    const result = await checkForDesktopUpdate({ currentVersion: '1.2.0-beta.10', channel: 'stable', fetchRelease: async () => new Response(JSON.stringify([release('1.1.1'), release('1.2.0-beta.11')])) })
    expect(result).toMatchObject({ latestVersion: '1.1.1', status: 'up_to_date' })
  })

  it('reads linked pages so frequent Beta releases cannot hide a stable update', async () => {
    const urls: string[] = []
    const result = await checkForDesktopUpdate({ currentVersion: '1.0.0', fetchRelease: async (url) => {
      urls.push(url)
      return urls.length === 1
        ? new Response(JSON.stringify([release('2.0.0-beta.1')]), { headers: { link: `<${RELEASES_API_URL}&page=2>; rel="next"` } })
        : new Response(JSON.stringify([release('1.1.0')]))
    } })
    expect(result.latestVersion).toBe('1.1.0')
    expect(urls).toEqual([RELEASES_API_URL, `${RELEASES_API_URL}&page=2`])
  })

  it('fails rather than claiming a complete result when listing exceeds the bounded page limit', async () => {
    await expect(checkForDesktopUpdate({ currentVersion: '1.0.0', fetchRelease: async () => new Response(JSON.stringify([release('1.1.0')]), { headers: { link: '<https://example.invalid/>; rel="next"' } }) })).rejects.toMatchObject({ code: 'UPDATE_CHECK_FAILED' })
  })

  it('returns a stable failure for unavailable, invalid or oversized data and cancellation', async () => {
    for (const response of [
      new Response('', { status: 503 }),
      new Response(JSON.stringify([{ draft: false, html_url: 'https://example.com/release', prerelease: false, tag_name: 'next' }])),
      new Response('x'.repeat(4 * 1024 * 1024 + 1)),
    ]) {
      await expect(checkForDesktopUpdate({
        currentVersion: '1.0.0',
        fetchRelease: async () => response,
      })).rejects.toMatchObject({ code: 'UPDATE_CHECK_FAILED' })
    }
    await expect(checkForDesktopUpdate({
      currentVersion: '1.0.0',
      signal: AbortSignal.abort(),
      fetchRelease: async () => new Response('[]'),
    })).rejects.toMatchObject({ code: 'UPDATE_CHECK_FAILED' })
  })
})
