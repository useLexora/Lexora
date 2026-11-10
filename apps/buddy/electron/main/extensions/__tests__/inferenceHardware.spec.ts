import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createInferenceHardwareProvider } from '../inferenceHardware'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
vi.mock('node:os', () => ({ cpus: () => Array.from({ length: 8 }), platform: vi.fn(), totalmem: () => 16 * 1024 ** 3 }))
beforeEach(() => {
  vi.mocked(platform).mockReturnValue('linux')
  nvidia('', new Error('Unavailable'))
})
afterEach(() => vi.useRealTimers())

function nvidia(output: string, error: Error | null = null) {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args[3] as (error: Error | null, stdout: string) => void
    callback(error, output)
  }) as typeof execFile)
}

it('samples bounded read-only GPU memory, coalesces concurrent reads and expires the cache', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(100000)
  nvidia('Fixture GPU, 8192, 4096\n')
  const provider = createInferenceHardwareProvider({
    getGPUInfo: async () => ({ GPUDevice: [{ vendorId: 0x10DE, deviceString: 'Fixture GPU', driverVersion: 'private' }], secret: 'private' }),
    getSystemMemoryInfo: () => ({ available: 8 * 1024 ** 2 }),
  })
  const snapshots = await Promise.all([provider(true), provider(true), provider(true)])
  expect(snapshots[0]).toEqual({ sampledAt: 100000, logicalCores: 8, totalMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 8 * 1024 ** 3, gpus: [{ name: 'Fixture GPU', vendor: 'nvidia', totalMemoryBytes: 8 * 1024 ** 3, availableMemoryBytes: 4 * 1024 ** 3 }] })
  expect(execFile).toHaveBeenCalledTimes(1)
  expect(execFile).toHaveBeenCalledWith('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], { timeout: 2000, maxBuffer: 8192, encoding: 'utf8', windowsHide: true, shell: false }, expect.any(Function))
  snapshots[0]!.gpus.length = 0
  expect((await provider(true)).gpus).toHaveLength(1)
  vi.setSystemTime(115001)
  expect((await provider(true)).sampledAt).toBe(115001)
  expect(execFile).toHaveBeenCalledTimes(2)
})

it('does not mistake free RAM or device names for available memory and enforces GPU omission', async () => {
  const getGPUInfo = vi.fn(async () => ({ GPUDevice: [{ vendorId: 0x1002, deviceString: 'GPU 24GB' }] }))
  const provider = createInferenceHardwareProvider({ getGPUInfo, getSystemMemoryInfo: () => ({ free: 1234 } as { available?: number }) })
  expect(await provider(false)).toEqual({ sampledAt: expect.any(Number), logicalCores: 8, totalMemoryBytes: 16 * 1024 ** 3, gpus: [] })
  expect(getGPUInfo).not.toHaveBeenCalled()
  expect(execFile).not.toHaveBeenCalled()
  expect((await provider(true)).gpus).toEqual([{ name: 'GPU 24GB', vendor: 'amd' }])
  expect(execFile).toHaveBeenCalledTimes(1)
})

it.each(['failed', 'invalid', 'too-large'] as const)('leaves unavailable NVIDIA memory unknown: %s', async (mode) => {
  nvidia(mode === 'invalid' ? 'Fixture GPU, 8192, 9000' : mode === 'too-large' ? 'Fixture GPU, 9999999999999999, 123' : '', mode === 'failed' ? new Error('missing executable') : null)
  const provider = createInferenceHardwareProvider({ getGPUInfo: async () => ({ GPUDevice: [{ vendorId: 0x10DE, deviceString: 'Fixture GPU' }] }), getSystemMemoryInfo: () => {
    throw new Error('Unavailable')
  } })
  expect(await provider(true)).toEqual({ sampledAt: expect.any(Number), logicalCores: 8, totalMemoryBytes: 16 * 1024 ** 3, gpus: [{ name: 'Fixture GPU', vendor: 'nvidia', ...(mode === 'invalid' ? { totalMemoryBytes: 8 * 1024 ** 3 } : {}) }] })
  await provider(true)
  expect(execFile).toHaveBeenCalledTimes(1)
})

it('discovers compute GPUs independently of Chromium software rendering', async () => {
  nvidia('Compute GPU, 8192, 4096\n')
  const provider = createInferenceHardwareProvider({ getGPUInfo: async () => ({ GPUDevice: [{ deviceString: 'Google SwiftShader' }] }), getSystemMemoryInfo: () => ({}) })
  expect((await provider(true)).gpus).toEqual([
    { name: 'Compute GPU', vendor: 'nvidia', totalMemoryBytes: 8 * 1024 ** 3, availableMemoryBytes: 4 * 1024 ** 3 },
  ])
})

it('keeps compute-device discovery bounded when Chromium GPU diagnostics never resolve', async () => {
  vi.useFakeTimers()
  nvidia('Compute GPU, 8192, 4096\n')
  const provider = createInferenceHardwareProvider({ getGPUInfo: () => new Promise(() => {}), getSystemMemoryInfo: () => ({}) })
  const pending = provider(true)
  await vi.advanceTimersByTimeAsync(1500)
  expect((await pending).gpus).toEqual([{ name: 'Compute GPU', vendor: 'nvidia', totalMemoryBytes: 8 * 1024 ** 3, availableMemoryBytes: 4 * 1024 ** 3 }])
})

it('preserves Apple GPU identity without inventing dedicated memory or probing NVIDIA', async () => {
  vi.mocked(platform).mockReturnValue('darwin')
  const provider = createInferenceHardwareProvider({ getGPUInfo: async () => ({ GPUDevice: [{ vendorString: 'Apple', deviceString: 'Apple GPU' }] }), getSystemMemoryInfo: () => ({}) })
  expect((await provider(true)).gpus).toEqual([{ name: 'Apple GPU', vendor: 'apple' }])
  expect(execFile).not.toHaveBeenCalled()
})

it.each([undefined, { GPUDevice: [{ deviceString: 'x'.repeat(257) }] }])('keeps CPU facts when GPU diagnostics are unavailable or malformed', async (info) => {
  const provider = createInferenceHardwareProvider({ getGPUInfo: async () => {
    if (!info)
      throw new Error('Unavailable')
    return info
  }, getSystemMemoryInfo: () => ({ available: -1 }) })
  expect(await provider(true)).toEqual({ sampledAt: expect.any(Number), logicalCores: 8, totalMemoryBytes: 16 * 1024 ** 3, gpus: [] })
})
