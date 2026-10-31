import type { LocalUsageTrend, UsagePeriod, UsageTrendRequest } from '@buddy-shared/usage/usageAnalyticsApi'
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { useUsageTrend } from '../useUsageTrend'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
async function settle() {
  await new Promise(resolve => setImmediate(resolve))
  await nextTick()
}

function fixture() {
  const scope = effectScope()
  scopes.push(scope)
  const requests: Array<{ input: UsageTrendRequest, resolve: (result: LocalUsageTrend) => void, reject: (error: Error) => void }> = []
  const annual = shallowRef<UsagePeriod>({ startDate: '2024-01-01', endDate: '2024-12-31', timeZone: 'UTC' })
  const revision = shallowRef(0)
  const runtime = shallowRef({ status: 'ready' })
  const owner = scope.run(() => useUsageTrend({
    api: { trend: input => new Promise((resolve, reject) => requests.push({ input, resolve, reject })) },
    language: shallowRef('zh-CN' as const),
    runtime,
    ready: Promise.resolve(),
    annual,
    revision,
  }))!
  return { scope, annual, revision, runtime, owner, requests }
}
const points: LocalUsageTrend = [{ startAt: '2024-02-29T08:00:00.000Z', endAt: '2024-02-29T09:00:00.000Z', totalTokens: 30, recordCount: 1 }]

describe('usage trend lifecycle', () => {
  it('changes actual query windows and rejects late responses or errors from the previous view', async () => {
    const f = fixture()
    await settle()
    expect(f.requests[0]!.input).toMatchObject({ startDate: '2024-12-01', endDate: '2024-12-31', granularity: 'day' })
    f.owner.setView('day')
    f.owner.setDate('2024-02-29')
    await settle()
    expect(f.requests[1]!.input).toEqual({ startDate: '2024-02-29', endDate: '2024-02-29', timeZone: 'UTC', granularity: 'hour' })
    f.requests[1]!.resolve(points)
    f.requests[0]!.reject(new Error('stale monthly query'))
    await settle()
    expect(f.owner.buckets.value).toEqual(points)
    expect(f.owner.error.value).toBeNull()
    expect(f.owner.loading.value).toBe(false)
    f.owner.setView('week')
    await settle()
    expect(f.requests[2]!.input).toMatchObject({ startDate: '2024-02-26', endDate: '2024-03-03', granularity: 'day' })
    f.owner.setView('month')
    await settle()
    expect(f.requests[3]!.input).toMatchObject({ startDate: '2024-02-01', endDate: '2024-02-29', granularity: 'day' })
    f.requests[3]!.resolve([])
    f.requests[2]!.resolve(points)
    await settle()
    expect(f.owner.buckets.value).toEqual([])
  })

  it('preserves the selected date on refresh and resets it on an annual scope change', async () => {
    const f = fixture()
    await settle()
    f.owner.setView('month')
    f.owner.setDate('2024-02-29')
    await settle()
    f.revision.value += 1
    await settle()
    expect(f.requests.at(-1)!.input).toMatchObject({ startDate: '2024-02-01', endDate: '2024-02-29' })
    expect(f.owner.date.value).toBe('2024-02-29')
    f.annual.value = { ...f.annual.value, startDate: '2025-01-01', endDate: '2025-12-31' }
    await settle()
    expect(f.owner.date.value).toBe('2025-12-31')
    expect(f.requests.at(-1)!.input).toMatchObject({ startDate: '2025-12-01', endDate: '2025-12-31' })
  })

  it('recovers failed queries and invalidates pending work on runtime restart and disposal', async () => {
    const f = fixture()
    await settle()
    f.requests[0]!.reject(new Error('read failed'))
    await settle()
    expect(f.owner.error.value).toBeTruthy()
    expect(f.owner.loading.value).toBe(false)
    f.owner.retry()
    await settle()
    f.runtime.value = { status: 'offline' }
    await settle()
    f.requests[1]!.resolve(points)
    await settle()
    expect(f.owner.buckets.value).toEqual([])
    f.runtime.value = { status: 'ready' }
    await settle()
    f.requests[2]!.resolve(points)
    await settle()
    expect(f.owner.buckets.value).toEqual(points)
    expect(f.owner.error.value).toBeNull()
    f.owner.retry()
    await settle()
    f.scope.stop()
    f.requests[3]!.resolve([{ ...points[0]!, totalTokens: 999 }])
    await settle()
    expect(f.owner.buckets.value).toEqual(points)
  })
})
