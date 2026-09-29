import type { Profiler } from 'node:inspector'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureCpuProfile, summarizeCpuProfile } from '../cpuProfile'

afterEach(() => vi.useRealTimers())
const profile: Profiler.Profile = {
  startTime: 0,
  endTime: 10000,
  nodes: [
    { id: 1, callFrame: { functionName: 'privateUserFunction', scriptId: '1', url: 'file:///home/private/file.js?secret=value', lineNumber: 99, columnNumber: 5 } },
    { id: 2, callFrame: { functionName: 'internalFunction', scriptId: '2', url: 'file:///app/index.js', lineNumber: 12, columnNumber: 3 } },
  ],
  samples: [1, 2, 2],
  timeDeltas: [2000, 3000, 5000],
}
describe('bounded CPU capture', () => {
  it('keeps only build code identifiers and sampled self time, dropping untrusted paths and function names', () => {
    const result = summarizeCpuProfile(profile, 'main', 42, url => url === 'file:///app/index.js' ? 'index.js' : null)
    expect(result.hotspots).toEqual([{ location: expect.stringMatching(/^main:[a-f0-9]{12}:13:4$/), selfMs: 8 }, { location: 'external', selfMs: 2 }])
    expect(JSON.stringify(result)).not.toMatch(/private|secret|Function|file:|index\.js/)
    expect(() => summarizeCpuProfile({ ...profile, samples: Array.from({ length: 20001 }, (_, index) => index) }, 'main', 42, () => null)).toThrow('CPU_PROFILE_LIMIT')
  })

  it('releases its inspector connection on cancellation and protocol failures', async () => {
    const controller = new AbortController()
    const closed: string[] = []
    const pending = captureCpuProfile({ send: async () => {
      controller.abort()
      return {}
    }, close: () => closed.push('aborted') }, 'main', 1, () => null, controller.signal)
    await expect(pending).rejects.toThrow()
    await expect(captureCpuProfile({ send: async () => {
      throw new Error('protocol')
    }, close: () => closed.push('failed') }, 'renderer', 2, () => null)).rejects.toThrow('protocol')
    expect(closed).toEqual(['aborted', 'failed'])
  })
})
