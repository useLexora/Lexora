import { describe, expect, it } from 'vitest'
import { isHttpEndpointUrl, isPlainHttpEndpointUrl } from '../networkSecurity'

describe('http endpoint URL policy', () => {
  it.each([
    'https://models.example.com/v1',
    'http://models.example.com/v1',
    'http://192.168.1.12:8153/v1',
    'http://127.0.0.1:11434/v1',
    'http://[::1]:11434/v1',
  ])('accepts HTTP and HTTPS endpoints: %s', (url) => {
    expect(isHttpEndpointUrl(url)).toBe(true)
  })

  it.each([
    'ftp://models.example.com/v1',
    'https://user:secret@models.example.com/v1',
    'http://user:secret@192.168.1.12:8153/v1',
    'not-a-url',
  ])('rejects unsupported or credential-bearing endpoints: %s', (url) => {
    expect(isHttpEndpointUrl(url)).toBe(false)
  })

  it('identifies valid unencrypted HTTP endpoints for non-blocking warnings', () => {
    expect(isPlainHttpEndpointUrl('http://models.example.com/v1')).toBe(true)
    expect(isPlainHttpEndpointUrl('https://models.example.com/v1')).toBe(false)
    expect(isPlainHttpEndpointUrl('http://user:secret@models.example.com/v1')).toBe(false)
  })
})
