export const CONTEXT_WINDOW_PRESETS = [
  { id: '32k', label: '32K', tokens: 32_000 },
  { id: '128k', label: '128K', tokens: 128_000 },
  { id: '200k', label: '200K', tokens: 200_000 },
  { id: '256k', label: '256K', tokens: 256_000 },
  { id: '1m', label: '1M', tokens: 1_000_000 },
] as const

export const DEFAULT_CONTEXT_WINDOW = 128_000
export const MIN_CONTEXT_COEFFICIENT = 1
export const MAX_CONTEXT_COEFFICIENT = 100_000

export type ContextWindowPresetId = typeof CONTEXT_WINDOW_PRESETS[number]['id'] | 'custom'

export function contextWindowPresetId(tokens: number): ContextWindowPresetId {
  return CONTEXT_WINDOW_PRESETS.find(preset => preset.tokens === tokens)?.id ?? 'custom'
}

export function outputTokensForContext(contextWindow: number): number {
  return Math.max(1, Math.floor(contextWindow / 2))
}

export function coefficientForContext(tokens: number): number {
  return clampContextCoefficient(Math.round(tokens / 1000))
}

export function contextWindowFromCoefficient(coefficient: number): number {
  return clampContextCoefficient(coefficient) * 1000
}

export function contextTokensFromCustomPaste(text: string): number | null {
  const match = /^(\d+)([km])?$/i.exec(text.trim().replace(/[,_\s]/g, ''))
  if (!match?.[1])
    return null
  const amount = Number(match[1])
  if (!Number.isSafeInteger(amount) || amount < 1)
    return null
  const unit = match[2]?.toLowerCase()
  const tokens = unit === 'm'
    ? amount * 1_000_000
    : unit === 'k'
      ? amount * 1_000
      : amount >= 10_000
        ? amount
        : amount * 1_000
  if (!Number.isSafeInteger(tokens))
    return null
  return contextWindowFromCoefficient(Math.round(tokens / 1000))
}

function clampContextCoefficient(coefficient: number): number {
  if (!Number.isFinite(coefficient))
    return MIN_CONTEXT_COEFFICIENT
  return Math.min(MAX_CONTEXT_COEFFICIENT, Math.max(MIN_CONTEXT_COEFFICIENT, Math.trunc(coefficient)))
}
