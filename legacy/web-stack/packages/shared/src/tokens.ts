export interface PrettyTokenCountOptions {
  precision?: number
  base?: number
}

export interface EstimateTextTokenCountOptions {
  safetyMultiplier?: number
}

const TOKEN_COUNT_UNITS = ['', 'K', 'M', 'B', 'T', 'P'] as const
const CJK_PATTERN = /[\u3400-\u9FFF\uF900-\uFAFF]/

export function prettyTokenCount(value: number, options: PrettyTokenCountOptions = {}): string {
  if (!Number.isFinite(value)) {
    return String(value)
  }

  const base = normalizeBase(options.base)
  const precision = normalizePrecision(options.precision, 1)
  const count = Math.max(0, Math.round(value))

  if (count < base) {
    return formatTokenNumber(count)
  }

  let exponent = Math.min(
    Math.floor(Math.log(count) / Math.log(base)),
    TOKEN_COUNT_UNITS.length - 1,
  )
  let result = Number((count / base ** exponent).toFixed(precision))
  if (result >= base && exponent < TOKEN_COUNT_UNITS.length - 1) {
    exponent += 1
    result = Number((count / base ** exponent).toFixed(precision))
  }

  return `${formatTokenNumber(result, precision)}${TOKEN_COUNT_UNITS[exponent]}`
}

export function prettyTokens(value: number, options: PrettyTokenCountOptions = {}): string {
  return `${prettyTokenCount(value, options)} tokens`
}

export function estimateTextTokenCount(text: string, options: EstimateTextTokenCountOptions = {}): number {
  const normalized = text.trim()
  if (!normalized) {
    return 0
  }

  const safetyMultiplier = normalizePositiveNumber(options.safetyMultiplier, 1)
  let estimated = 0
  for (const char of normalized) {
    if (/\s/.test(char)) {
      estimated += 0.1
    }
    else if (CJK_PATTERN.test(char)) {
      estimated += 1.8
    }
    else if (char.charCodeAt(0) > 127) {
      estimated += 1
    }
    else {
      estimated += 0.25
    }
  }

  return Math.max(1, Math.ceil(estimated * safetyMultiplier))
}

function formatTokenNumber(value: number, precision = 0) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: precision,
  }).format(value)
}

function normalizeBase(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value <= 1) {
    return 1000
  }

  return value
}

function normalizePrecision(value: number | undefined, fallback: number) {
  if (value === undefined) {
    return fallback
  }

  if (!Number.isFinite(value)) {
    return fallback
  }

  return Math.min(Math.max(Math.trunc(value), 0), 20)
}

function normalizePositiveNumber(value: number | undefined, fallback: number) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback
  }

  return value
}
