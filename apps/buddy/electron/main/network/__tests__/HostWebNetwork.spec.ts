import type { Session } from 'electron'
import { describe, expect, it } from 'vitest'
import { WebError } from '../../../../shared/network/webProtocol'
import { HostWebNetwork } from '../HostWebNetwork'

const signal = () => new AbortController().signal
const authorized = { authorize: async () => {} }
const request = (url: string) => ({ url, method: 'GET' as const, scope: 'public' as const, headers: {} })

describe('host network routing', () => {
  it('reads through the host transport even when independent DNS resolution is unavailable', async () => {
    const session = {
      resolveHost: async () => { throw new Error('Independent DNS unavailable') },
      resolveProxy: async () => { throw new Error('Proxy selection belongs to the host transport') },
    } as unknown as Session
    const network = new HostWebNetwork(session, async (_session, input) => new Response(`Content from ${input.url}`))
    const result = await network.fetch(request('https://www.google.com/search?q=Electron'), signal(), authorized)
    expect(result.url).toBe('https://www.google.com/search?q=Electron')
    expect(await result.response.text()).toBe('Content from https://www.google.com/search?q=Electron')
  })

  it('follows a public redirect with the original hostnames and query intact', async () => {
    const visited: string[] = []
    const network = new HostWebNetwork({} as Session, async (_session, input) => {
      visited.push(input.url)
      return visited.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://docs.example.com/page?q=a%2Fb' } })
        : new Response('Redirected content')
    })
    const result = await network.fetch(request('https://example.com/start'), signal(), authorized)
    expect(result.url).toBe('https://docs.example.com/page?q=a%2Fb')
    expect(await result.response.text()).toBe('Redirected content')
    expect(visited).toEqual(['https://example.com/start', 'https://docs.example.com/page?q=a%2Fb'])
  })

  it('revalidates redirects against the public URL policy', async () => {
    const url = 'http://169.254.169.254/'
    const network = new HostWebNetwork({} as Session, async () => new Response(null, { status: 302, headers: { location: url } }))
    await expect(network.authorizePublicUrl(url)).rejects.toThrow('WEB_URL_BLOCKED')
    await expect(network.fetch(request('https://example.com/'), signal(), authorized)).rejects.toThrow('WEB_URL_BLOCKED')
  })

  it('preserves the host connection failure instead of classifying it as a URL block', async () => {
    const network = new HostWebNetwork({} as Session, async () => {
      throw new WebError('WEB_NETWORK_ERROR')
    })
    await expect(network.fetch(request('https://example.com/'), signal(), authorized)).rejects.toThrow('WEB_NETWORK_ERROR')
  })
})
