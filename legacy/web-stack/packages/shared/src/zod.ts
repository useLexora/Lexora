import { z } from 'zod'

export function requiredEnvString(name: string) {
  return z.string().trim().min(1, `${name} 是必填配置`)
}

export function stringWithDefault(fallback: string) {
  return z
    .string()
    .trim()
    .optional()
    .transform(value => value?.length ? value : fallback)
}

export function optionalNonEmptyString() {
  return z
    .string()
    .trim()
    .optional()
    .transform(value => value?.length ? value : undefined)
}

export function positiveIntegerWithDefault(fallback: number) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') {
      return fallback
    }

    return Number(value)
  }, z.number().int().positive())
}
