import { describe, expect, it } from 'vitest'
import { normalizeModelRequestFailure } from '../modelRequestFailure'

describe('provider error disclosure', () => {
  it.each(['apiKey', 'api_key', 'token', 'access_token', 'refreshToken', 'client_secret', 'password', 'credential', 'authorization'])('redacts JSON %s values while preserving the provider failure', (key) => {
    const secret = 'fixture-secret-"escaped"-value'
    const result = normalizeModelRequestFailure(`401 authentication failed: ${JSON.stringify({ [key]: secret, reason: 'invalid credential' })}`)
    expect(result.code).toBe('PROVIDER_AUTHENTICATION_FAILED')
    expect(result.message).toContain(`"${key}":"[redacted]"`)
    expect(result.message).not.toContain('fixture-secret')
    expect(result.message).toContain('"reason":"invalid credential"')
  })

  it.each(['fixture-provided-key', '"fixture-provided-key"', '\'fixture-provided-key\''])('redacts echoed incorrect API keys: %s', (value) => {
    const result = normalizeModelRequestFailure(`401 Incorrect API key provided: ${value}. Check your provider settings.`)
    expect(result.code).toBe('PROVIDER_AUTHENTICATION_FAILED')
    expect(result.message).toContain('Incorrect API key provided: [redacted]')
    expect(result.message).not.toContain('fixture-provided-key')
    expect(result.message).toContain('Check your provider settings.')
  })

  it('keeps the existing redaction and bounded failure details', () => {
    const result = normalizeModelRequestFailure(`429 rate limited. Bearer fixture-bearer. ${'details '.repeat(1024)}`)
    expect(result.code).toBe('PROVIDER_RATE_LIMITED')
    expect(result.message).toContain('Bearer [redacted]')
    expect(result.message).not.toContain('fixture-bearer')
    expect(result.message).toHaveLength(4096)
  })
})
