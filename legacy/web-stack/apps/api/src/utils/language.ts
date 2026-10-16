import type { ResolvedLanguagePreference } from '@haohaoxue/lexora-contracts'
import type { FastifyRequest } from 'fastify'
import { LANGUAGE_PREFERENCE } from '@haohaoxue/lexora-contracts/user/constants'
import { resolveLanguagePreference } from '@haohaoxue/lexora-shared'

interface AcceptLanguageItem {
  language: string
  quality: number
  order: number
}

export function resolveRequestLanguage(request: FastifyRequest): ResolvedLanguagePreference {
  return resolveLanguagePreference(
    LANGUAGE_PREFERENCE.AUTO,
    readAcceptLanguageHeader(request.headers['accept-language']),
  )
}

export function resolvePreferredLanguage(input: {
  languagePreference?: Parameters<typeof resolveLanguagePreference>[0] | null
  preferredLanguages?: readonly string[]
}): ResolvedLanguagePreference {
  return resolveLanguagePreference(
    input.languagePreference ?? LANGUAGE_PREFERENCE.AUTO,
    input.preferredLanguages ?? [],
  )
}

export function readAcceptLanguageHeader(value: string | string[] | undefined): string[] {
  const header = Array.isArray(value) ? value.join(',') : value ?? ''

  return header
    .split(',')
    .map(parseAcceptLanguageItem)
    .filter(item => item.language && item.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.order - right.order)
    .map(item => item.language)
}

function parseAcceptLanguageItem(value: string, order: number): AcceptLanguageItem {
  const parts = value.split(';').map(item => item.trim())
  const language = parts[0] ?? ''
  const qualityPart = parts.find(item => item.toLowerCase().startsWith('q='))
  const quality = qualityPart ? Number.parseFloat(qualityPart.slice(2)) : 1

  return {
    language,
    quality: Number.isFinite(quality) ? quality : 1,
    order,
  }
}
