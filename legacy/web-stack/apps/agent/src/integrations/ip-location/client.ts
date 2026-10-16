import type { AgentLocation } from '@haohaoxue/lexora-contracts'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'

const IP_LOCATION_REQUEST_TIMEOUT_MS = 1500
const IP_LOCATION_CACHE_TTL_MS = 60 * 60 * 1000
const IP_LOCATION_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000
const IP_LOCATION_DEFAULT_ACCURACY_METERS = 50_000
const IP_LOCATION_CACHE_MAX_ENTRIES = 1024

const IpWhoIsResponseSchema = z.object({
  success: z.boolean().optional(),
  city: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  country_code: z.string().nullable().optional(),
  latitude: z.union([z.number(), z.string()]).nullable().optional(),
  longitude: z.union([z.number(), z.string()]).nullable().optional(),
}).passthrough()

const IpApiCoResponseSchema = z.object({
  error: z.boolean().optional(),
  city: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  country_code: z.string().nullable().optional(),
  latitude: z.union([z.number(), z.string()]).nullable().optional(),
  longitude: z.union([z.number(), z.string()]).nullable().optional(),
}).passthrough()

interface IpLocationProvider {
  readonly name: string
  readonly createUrl: (ip: string) => string
  readonly fetchMode?: 'cors' | 'no-cors' | 'same-origin'
  readonly parse: (value: unknown) => AgentLocation | null
}

interface CachedIpLocation {
  readonly expiresAt: number
  readonly location: AgentLocation | null
}

const cache = new Map<string, CachedIpLocation>()

const IP_LOCATION_PROVIDERS = [
  {
    name: 'ipwho.is',
    createUrl: (ip: string) => `https://ipwho.is/${encodeURIComponent(ip)}`,
    fetchMode: 'no-cors',
    parse: createAgentLocationFromIpWhoIsResponse,
  },
  {
    name: 'ipapi.co',
    createUrl: (ip: string) => `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
    parse: createAgentLocationFromIpApiCoResponse,
  },
] satisfies readonly IpLocationProvider[]

export async function resolveOnlineIpLocation(ip: string): Promise<AgentLocation | null> {
  if (!isIP(ip)) {
    return null
  }

  const now = Date.now()
  const cacheKey = createIpCacheKey(ip)
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.location
  }

  const location = await fetchIpLocation(ip)
  sweepExpiredCache(now)
  cache.set(cacheKey, {
    expiresAt: now + (location ? IP_LOCATION_CACHE_TTL_MS : IP_LOCATION_NEGATIVE_CACHE_TTL_MS),
    location,
  })
  trimCacheToMaxEntries()

  return location
}

function sweepExpiredCache(now: number): void {
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) {
      cache.delete(key)
    }
  }
}

function trimCacheToMaxEntries(): void {
  while (cache.size > IP_LOCATION_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (!oldestKey) {
      return
    }

    cache.delete(oldestKey)
  }
}

async function fetchIpLocation(ip: string): Promise<AgentLocation | null> {
  for (const provider of IP_LOCATION_PROVIDERS) {
    const location = await fetchIpLocationFromProvider(ip, provider)
    if (location) {
      return location
    }
  }

  return null
}

async function fetchIpLocationFromProvider(
  ip: string,
  provider: IpLocationProvider,
): Promise<AgentLocation | null> {
  try {
    const response = await fetch(provider.createUrl(ip), {
      mode: provider.fetchMode,
      signal: AbortSignal.timeout(IP_LOCATION_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      return null
    }

    return provider.parse(await response.json())
  }
  catch {
    return null
  }
}

function createIpCacheKey(ip: string): string {
  return createHash('sha256').update(ip).digest('hex')
}

function createAgentLocationFromIpWhoIsResponse(value: unknown): AgentLocation | null {
  const parsed = IpWhoIsResponseSchema.safeParse(value)
  if (!parsed.success || parsed.data.success === false) {
    return null
  }

  const response = parsed.data
  return createAgentLocationFromParts({
    labelParts: [
      response.city,
      response.region,
      response.country_code,
    ],
    coordinates: parseLatitudeLongitude(response.latitude, response.longitude),
  })
}

function createAgentLocationFromIpApiCoResponse(value: unknown): AgentLocation | null {
  const parsed = IpApiCoResponseSchema.safeParse(value)
  if (!parsed.success || parsed.data.error) {
    return null
  }

  const response = parsed.data
  return createAgentLocationFromParts({
    labelParts: [
      response.city,
      response.region,
      response.country_code,
    ],
    coordinates: parseLatitudeLongitude(response.latitude, response.longitude),
  })
}

function createAgentLocationFromParts(input: {
  labelParts: Array<string | null | undefined>
  coordinates?: {
    latitude: number
    longitude: number
  } | null
}): AgentLocation | null {
  const label = joinUniqueLocationParts(input.labelParts)
  const coordinates = input.coordinates
    ? {
        ...input.coordinates,
        accuracyMeters: IP_LOCATION_DEFAULT_ACCURACY_METERS,
      }
    : undefined

  if (!label && !coordinates) {
    return null
  }

  return {
    ...(label ? { label } : {}),
    ...(coordinates ? { coordinates } : {}),
  }
}

function parseLatitudeLongitude(
  latitudeValue: string | number | null | undefined,
  longitudeValue: string | number | null | undefined,
): {
  latitude: number
  longitude: number
} | null {
  const latitude = parseCoordinate(latitudeValue)
  const longitude = parseCoordinate(longitudeValue)

  return latitude === null || longitude === null
    ? null
    : { latitude, longitude }
}

function parseCoordinate(value: string | number | null | undefined): number | null {
  const numberValue = typeof value === 'number' ? value : Number(value?.trim() ?? '')
  return Number.isFinite(numberValue) ? numberValue : null
}

function joinUniqueLocationParts(parts: Array<string | null | undefined>): string {
  const seen = new Set<string>()
  const normalizedParts: string[] = []
  for (const part of parts) {
    const normalized = part?.trim()
    if (!normalized || seen.has(normalized.toLowerCase())) {
      continue
    }

    seen.add(normalized.toLowerCase())
    normalizedParts.push(normalized)
  }

  return normalizedParts.join(', ')
}
