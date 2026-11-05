import { expect, it } from 'vitest'
import { EXTENSION_NETWORK_LINK_BYTES_LIMIT, extensionNetworkResponseSchema, projectExtensionNetworkHeaders } from '../extensionNetwork'

const link = '<https://example.com/models?cursor=next%2Fpage>; rel="next", <https://example.com/models?cursor=first>; rel="first"'

it('projects only Link without changing pagination values or exposing other headers', () => {
  const headers = new Headers({
    'LiNk': link,
    'Cookie': 'fixture=private',
    'Set-Cookie': 'fixture=private',
    'Authorization': 'Bearer fixture',
    'Proxy-Authorization': 'Basic fixture',
    'X-Private': 'private',
    'Location': 'https://example.com/private',
  })
  expect(projectExtensionNetworkHeaders(headers)).toEqual({ link })
  expect(projectExtensionNetworkHeaders(new Headers())).toEqual({})
  expect(projectExtensionNetworkHeaders(new Headers({ Link: '' }))).toEqual({})
})

it.each(['a', 'é'])('enforces the complete Link UTF-8 byte budget for %s without truncation', (character) => {
  const length = EXTENSION_NETWORK_LINK_BYTES_LIMIT / new TextEncoder().encode(character).byteLength
  const value = character.repeat(length)
  expect(projectExtensionNetworkHeaders(new Headers({ Link: value }))).toEqual({ link: value })
  expect(() => projectExtensionNetworkHeaders(new Headers({ Link: value + character }))).toThrow('EXTENSION_NETWORK_HEADERS_TOO_LARGE')
})

it('validates the narrow response wire format and rejects additional or unbounded metadata', () => {
  const response = { status: 200, text: '[]', headers: { link } }
  expect(extensionNetworkResponseSchema.parse(response)).toEqual(response)
  expect(extensionNetworkResponseSchema.parse({ ...response, headers: {} })).toEqual({ ...response, headers: {} })
  for (const headers of [{ link, 'set-cookie': 'private' }, { authorization: 'private' }, { link: 'a'.repeat(EXTENSION_NETWORK_LINK_BYTES_LIMIT + 1) }, { link: null }])
    expect(extensionNetworkResponseSchema.safeParse({ ...response, headers }).success).toBe(false)
})
