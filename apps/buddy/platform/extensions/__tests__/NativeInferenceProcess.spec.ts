import type { ApplicationDiagnostic } from '../../../shared/diagnostics/applicationDiagnostic'
import { afterEach, expect, it, vi } from 'vitest'
import { inferenceLimits } from '../../../shared/extensions/extensionInference'
import { invocation, memoryInference } from './inferenceFixtures'

const fixtures: ReturnType<typeof memoryInference>[] = []
function fixture(options?: Parameters<typeof memoryInference>[0]) {
  const result = memoryInference(options)
  fixtures.push(result)
  return result
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.close()
    await f.reading
  }
  vi.useRealTimers()
})

it('preserves binary output and rejects oversized requests without poisoning a reusable call id', async () => {
  const { worker } = fixture()
  await expect(worker.invoke(invocation({ input: { text: 'x'.repeat(inferenceLimits.controlBytes) } }))).rejects.toThrow('EXTENSION_INFERENCE_FRAME_LIMIT')
  expect(worker.stopped).toBe(false)
  expect(worker.cancelling).toBe(0)
  const events: unknown[] = []
  await worker.invoke(invocation({
    input: { recovered: true },
    chunks: (async function* () { yield new Uint8Array(1024) })(),
    event(data, bytes) { events.push({ data, bytes: [...bytes] }) },
  }))
  expect(events).toEqual([{ data: { size: 1024, input: { recovered: true } }, bytes: [1, 2, 3, 4] }])
})

it('records only bounded structured inference facts from native stderr without exposing raw engine output', async () => {
  const records: ApplicationDiagnostic[] = []
  const f = fixture({ record: event => records.push(event) })
  f.stderr.write('raw engine /fixture/private-model prompt=fixture-secret\n')
  f.stderr.write('{"event":"chat.gpu.ready","loadMs":12,')
  f.stderr.write('"engine":{"name":"llama.cpp","version":"b9999","path":"/fixture/private-engine"},"input":"fixture-secret"}\n')
  f.stderr.write(`${JSON.stringify({ event: 'chat.gpu.error', code: 'EXTENSION_INFERENCE_DRIVER_INCOMPATIBLE', backend: { requested: 'cuda', observed: ['cpu'] }, device: [{ backend: 'cpu', index: 0, name: 'fixture-private-device' }], degraded: true })}\n`)
  f.stderr.write(`${JSON.stringify({ event: 'chat.gpu.unknown', path: '/fixture/private' })}\n`)
  f.stderr.write(`${JSON.stringify({ event: 'chat.gpu.ready', architecture: '/fixture/private-model' })}\n`)
  f.stderr.write(`${JSON.stringify({ event: 'chat.gpu.ready', loadMs: -1 })}\n`)
  f.stderr.write(`${JSON.stringify({ event: 'chat.gpu.ready', backend: { requested: 'fixture-secret', observed: [] } })}\n`)
  f.stderr.write(`${JSON.stringify({ event: 'chat.gpu.ready', path: 'x'.repeat(9000) })}\n`)
  f.stderr.write('x'.repeat(9000))
  f.stderr.write(`${JSON.stringify({ event: 'chat.gpu.ready' })}\n`)
  f.stderr.write('{"event":"chat.gpu.timings","prompt":{"tokens":10,"ms":25},"decode":{"tokens":3,"ms":15}}')
  f.close()
  await f.reading
  expect(records).toEqual([
    { event: 'chat.gpu.ready', component: 'models.inference', level: 'info', extensionId: 'fixture.inference', operationId: f.worker.instanceId, inference: { loadMs: 12, engine: { name: 'llama.cpp', version: 'b9999' } } },
    { event: 'chat.gpu.error', component: 'models.inference', level: 'error', extensionId: 'fixture.inference', operationId: f.worker.instanceId, errorCode: 'EXTENSION_INFERENCE_DRIVER_INCOMPATIBLE', inference: { backend: { requested: 'cuda', observed: ['cpu'] }, device: [{ backend: 'cpu', index: 0 }], degraded: true } },
    { event: 'chat.gpu.timings', component: 'models.inference', level: 'info', extensionId: 'fixture.inference', operationId: f.worker.instanceId, inference: { prompt: { tokens: 10, ms: 25 }, decode: { tokens: 3, ms: 15 } } },
  ])
  expect(JSON.stringify(records)).not.toContain('fixture-private')
  expect(JSON.stringify(records)).not.toContain('fixture-secret')
})

it('keeps inference usable when the diagnostic sink fails or stderr floods', async () => {
  const records: ApplicationDiagnostic[] = []
  const f = fixture({ record: (event) => {
    records.push(event)
    throw new Error('fixture sink unavailable')
  } })
  f.stderr.write('{"event":"chat.gpu.ready"}\n'.repeat(10000))
  await f.worker.invoke(invocation())
  expect(records.length).toBeGreaterThan(0)
  expect(records.length).toBeLessThan(10000)
  expect(f.worker.stopped).toBe(false)
})

it('waits for accepted consumer work to drain after cancellation', async () => {
  const f = fixture()
  const entered = Promise.withResolvers<void>()
  const drain = Promise.withResolvers<void>()
  const controller = new AbortController()
  let settled = false
  const call = f.worker.invoke(invocation({
    signal: controller.signal,
    event() {
      entered.resolve()
      return drain.promise
    },
  })).finally(() => { settled = true })
  const cancelled = expect(call).rejects.toThrow('fixture cancellation')
  await entered.promise
  controller.abort(new Error('fixture cancellation'))
  await f.received('cancel', 'call')
  expect(settled).toBe(false)
  expect(f.worker.cancelling).toBe(1)
  drain.resolve()
  await cancelled
  expect(f.worker.cancelling).toBe(0)
  expect(f.worker.stopped).toBe(false)
})

it('bounds unresponsive cancellation after the last healthy shared call completes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture({ ignoreExit: true })
  const controller = new AbortController()
  const active = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  const events: unknown[] = []
  const first = f.worker.invoke(invocation({ id: 'cancelled', input: { ignoreFinish: true }, signal: controller.signal }))
  const cancelled = expect(first).rejects.toThrow('EXTENSION_INFERENCE_PROCESS_EXITED')
  await f.received('finish', 'cancelled')
  const second = f.worker.invoke(invocation({
    id: 'healthy',
    ready: () => {
      ready.resolve()
      return active.promise
    },
    event(data) { events.push(data) },
  }))
  await ready.promise
  controller.abort(new Error('fixture cancellation'))
  await f.received('finish', 'cancelled')
  await vi.advanceTimersByTimeAsync(2 * inferenceLimits.stopTimeoutMs)
  expect(f.worker.stopped).toBe(false)
  expect(f.worker.cancelling).toBe(1)
  active.resolve()
  await second
  expect(events).toEqual([{ size: 0, input: {} }])
  await vi.advanceTimersByTimeAsync(2 * inferenceLimits.stopTimeoutMs)
  expect(f.worker.stopped).toBe(true)
  await cancelled
  expect(f.worker.cancelling).toBe(0)
})

it('disarms cancellation retirement for a new healthy call and rearms it when that call leaves', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture({ ignoreExit: true })
  const controller = new AbortController()
  const first = f.worker.invoke(invocation({ id: 'cancelled', input: { ignoreFinish: true }, signal: controller.signal }))
  const cancelled = expect(first).rejects.toThrow('EXTENSION_INFERENCE_PROCESS_EXITED')
  await f.received('finish', 'cancelled')
  controller.abort(new Error('fixture cancellation'))
  await f.received('cancel', 'cancelled')
  await vi.advanceTimersByTimeAsync(inferenceLimits.stopTimeoutMs - 1)
  const active = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  const second = f.worker.invoke(invocation({ id: 'healthy', ready: () => {
    ready.resolve()
    return active.promise
  } }))
  await ready.promise
  await vi.advanceTimersByTimeAsync(2 * inferenceLimits.stopTimeoutMs)
  expect(f.worker.stopped).toBe(false)
  expect(f.worker.cancelling).toBe(1)
  active.resolve()
  await second
  await vi.advanceTimersByTimeAsync(2 * inferenceLimits.stopTimeoutMs)
  expect(f.worker.stopped).toBe(true)
  await cancelled
  expect(f.worker.cancelling).toBe(0)
})
