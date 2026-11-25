import { describe, expect, it } from 'vitest'
import { pluginChatApi } from '../../../../shared/extensions/extensionChat'
import { modelFailureFeedback } from '../../../../shared/providers/modelFailureFeedback'
import { readModelLaunchFailure } from '../../../../shared/providers/modelLaunchFailure'
import { normalizeModelRequestFailure, PLUGIN_LAUNCH_STORAGE_DIAGNOSTIC } from '../modelRequestFailure'

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

describe('plugin inference failures', () => {
  it.each([
    ['EXTENSION_INFERENCE_CONTEXT_TOO_LARGE', 'MODEL_INPUT_TOO_LARGE'],
    ['EXTENSION_INFERENCE_STORAGE_FULL', 'MODEL_STORAGE_FULL'],
    ['EXTENSION_INFERENCE_RESOURCE_EXHAUSTED', 'MODEL_RESOURCE_EXHAUSTED'],
    ['EXTENSION_INFERENCE_INPUT_UNSUPPORTED', 'MODEL_INPUT_UNSUPPORTED'],
    ['EXTENSION_INFERENCE_OUTPUT_INCOMPLETE', 'MODEL_STREAM_INCOMPLETE'],
  ])('preserves the actionable meaning of %s', (message, code) => {
    expect(normalizeModelRequestFailure(message).code).toBe(code)
  })

  it.each([
    ['LAUNCH_QUOTA_EXCEEDED', 'launch', 'unknown', 'quota_exceeded', /quota/i],
    ['LAUNCH_NO_SPACE', 'launch', 'unknown', 'no_space', /no space/i],
    ['STORAGE_QUOTA_EXCEEDED', 'unknown', 'unknown', 'quota_exceeded', /quota/i],
    ['STORAGE_NO_SPACE', 'unknown', 'unknown', 'no_space', /no space/i],
    ['STORAGE_FULL', 'unknown', 'unknown', 'storage_full_or_quota_exceeded', /space or quota/i],
  ] as const)('shares bounded facts for %s without guessing the write location', (suffix, stage, location, reason, summary) => {
    const { code } = normalizeModelRequestFailure({ errorMessage: `EXTENSION_INFERENCE_${suffix}`, api: pluginChatApi })
    const fact = modelFailureFeedback(code)
    expect(fact).toEqual({ code: `MODEL_${suffix}`, stage, location, reason, summary: expect.stringMatching(summary) })
    expect(fact?.summary).not.toContain('/cache/')
  })

  it.each(['LAUNCH_QUOTA_EXCEEDED', 'LAUNCH_NO_SPACE', 'STORAGE_QUOTA_EXCEEDED', 'STORAGE_NO_SPACE'])('does not promote %s from arbitrary provider text to a host fact', (suffix) => {
    const errorMessage = `EXTENSION_INFERENCE_${suffix}`
    expect(normalizeModelRequestFailure(errorMessage).code).toBe('MODEL_REQUEST_FAILED')
    expect(normalizeModelRequestFailure({ errorMessage, api: 'openai-completions' }).code).toBe('MODEL_REQUEST_FAILED')
  })

  it('checks the recorded code and the complete bounded location, leaving legacy records untouched', () => {
    const code = 'MODEL_LAUNCH_NO_SPACE'
    const location = '<profile>/cache/extensions/fixture.local/launches'
    const record = { version: 1, code, location }
    expect(readModelLaunchFailure(code, record)).toEqual(record)
    expect(readModelLaunchFailure('MODEL_LAUNCH_QUOTA_EXCEEDED', record)).toBeUndefined()
    for (const invalid of [null, undefined, 'EXTENSION_INFERENCE_LAUNCH_NO_SPACE', { ...record, version: 2 }, { ...record, secret: '/private' }])
      expect(readModelLaunchFailure(code, invalid)).toBeUndefined()
    for (const path of ['/private/launches', `${location}\n`, location.replace('fixture.local', '../private'), location.replace('fixture.local', 'a.b'.padEnd(121, 'a'))])
      expect(readModelLaunchFailure(code, { ...record, location: path })).toBeUndefined()
  })

  it('never accepts a claimed location from provider error text, another provider or mismatched diagnostics', () => {
    const code = 'MODEL_LAUNCH_NO_SPACE'
    const error = 'EXTENSION_INFERENCE_LAUNCH_NO_SPACE'
    const location = '<profile>/cache/extensions/fixture.local/launches'
    const claimed = JSON.stringify({ version: 1, code, location })
    const diagnostic = { type: PLUGIN_LAUNCH_STORAGE_DIAGNOSTIC, timestamp: 1, details: { error, location } }
    const plugin = { api: pluginChatApi, provider: 'plugin:fixture.local', diagnostics: [diagnostic] }
    expect(normalizeModelRequestFailure({ ...plugin, errorMessage: claimed })).toEqual({ code: 'MODEL_REQUEST_FAILED' })
    expect(normalizeModelRequestFailure({ ...plugin, api: 'openai-completions', errorMessage: claimed }).launchFailure).toBeUndefined()
    expect(normalizeModelRequestFailure({ ...plugin, api: 'openai-completions', errorMessage: error }).launchFailure).toBeUndefined()
    for (const details of [{ error, location: '/private/launches' }, { error, location: location.replace('fixture.local', 'another.model') }, { error: 'EXTENSION_INFERENCE_LAUNCH_QUOTA_EXCEEDED', location }])
      expect(normalizeModelRequestFailure({ ...plugin, errorMessage: error, diagnostics: [{ ...diagnostic, details }] })).toEqual({ code, message: error })
    expect(normalizeModelRequestFailure({ ...plugin, errorMessage: '/private/failure' })).toEqual({ code: 'MODEL_REQUEST_FAILED' })
    expect(normalizeModelRequestFailure({ ...plugin, errorMessage: 'EXTENSION_INFERENCE_BACKEND_FAILED' })).toEqual({ code: 'MODEL_REQUEST_FAILED', message: 'EXTENSION_INFERENCE_BACKEND_FAILED' })
  })

  it('never derives AI feedback from provider text or unknown error identifiers', () => {
    const { code } = normalizeModelRequestFailure('ENOSPC in /private/fixture')
    expect(modelFailureFeedback(code)).toEqual({ code: 'MODEL_REQUEST_FAILED', stage: 'unknown', location: 'unknown', reason: 'unknown', summary: 'The model request failed. The cause is unknown.' })
    for (const value of [undefined, null, '', '__proto__', 'constructor', '/private/fixture', 'MODEL_REQUEST_FAILED /private/fixture'])
      expect(modelFailureFeedback(value)).toBeUndefined()
  })

  it.each([
    ['EXTENSION_INFERENCE_ENGINE_TOO_OLD', 'MODEL_ENGINE_TOO_OLD'],
    ['EXTENSION_INFERENCE_MODEL_ARCHITECTURE_UNSUPPORTED', 'MODEL_ARCHITECTURE_UNSUPPORTED'],
    ['EXTENSION_INFERENCE_MODEL_QUANTIZATION_UNSUPPORTED', 'MODEL_QUANTIZATION_UNSUPPORTED'],
    ['EXTENSION_INFERENCE_DRIVER_INCOMPATIBLE', 'MODEL_DRIVER_INCOMPATIBLE'],
    ['EXTENSION_INFERENCE_BACKEND_UNAVAILABLE', 'MODEL_BACKEND_UNAVAILABLE'],
    ['EXTENSION_INFERENCE_LOAD_TIMEOUT', 'MODEL_REQUEST_TIMED_OUT'],
    ['EXTENSION_INFERENCE_REQUEST_TIMEOUT', 'MODEL_REQUEST_TIMED_OUT'],
  ] as const)('classifies %s without losing the plugin failure code', (message, code) => {
    expect(normalizeModelRequestFailure({ errorMessage: message, diagnostics: [] })).toEqual({ code, message })
  })
})
