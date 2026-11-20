import { describe, expect, it } from 'vitest'
import {
  coefficientForContext,
  contextTokensFromCustomPaste,
  contextWindowPresetId,
  outputTokensForContext,
} from '../contextWindowPreset'

describe('context window presets', () => {
  it('maps the fixed tiers and leaves other values custom', () => {
    expect(contextWindowPresetId(32_000)).toBe('32k')
    expect(contextWindowPresetId(128_000)).toBe('128k')
    expect(contextWindowPresetId(200_000)).toBe('200k')
    expect(contextWindowPresetId(256_000)).toBe('256k')
    expect(contextWindowPresetId(1_000_000)).toBe('1m')
    expect(contextWindowPresetId(272_000)).toBe('custom')
  })

  it('sets maximum output to half of the context window', () => {
    expect(outputTokensForContext(32_000)).toBe(16_000)
    expect(outputTokensForContext(128_000)).toBe(64_000)
    expect(outputTokensForContext(200_000)).toBe(100_000)
    expect(outputTokensForContext(256_000)).toBe(128_000)
    expect(outputTokensForContext(1_000_000)).toBe(500_000)
    expect(outputTokensForContext(272_000)).toBe(136_000)
    expect(outputTokensForContext(1)).toBe(1)
  })

  it('parses a custom coefficient or a pasted token count as thousands', () => {
    expect(coefficientForContext(272_000)).toBe(272)
    expect(coefficientForContext(131_072)).toBe(131)
    expect(contextTokensFromCustomPaste('272')).toBe(272_000)
    expect(contextTokensFromCustomPaste('272000')).toBe(272_000)
    expect(contextTokensFromCustomPaste('272,000')).toBe(272_000)
    expect(contextTokensFromCustomPaste('272k')).toBe(272_000)
    expect(contextTokensFromCustomPaste('1M')).toBe(1_000_000)
    expect(contextTokensFromCustomPaste('nope')).toBeNull()
  })
})
