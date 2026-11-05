import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { writeInferenceInitialization } from '../inferenceInitialization'
import { writeInferenceFrame } from '../inferenceWire'
import { NativeInferenceProcess } from '../NativeInferenceProcess'
import { invocation } from './inferenceFixtures'

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'lexora-inference-worker-test-'))
  const result = await build({ configFile: false, envFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: { write: false, minify: false, target: 'esnext', ssr: fileURLToPath(new URL('../inferenceWorker.ts', import.meta.url)), rollupOptions: { external: [/^node:/], output: { codeSplitting: false } } } })
  const output = Array.isArray(result) ? result[0]!.output : 'output' in result ? result.output : []
  const bootstrap = output.find(item => item.type === 'chunk')
  if (bootstrap?.type !== 'chunk')
    throw new Error('Missing worker bootstrap')
  await writeFile(join(root, 'worker.mjs'), bootstrap.code)
  await writeFile(join(root, 'backend.mjs'), `
export function initialize() {
  const held = new Set()
  let aborted = 0
  let committed = 0
  return {
    start(_capability, input, call) {
      const resource = {}
      held.add(resource)
      call.signal.addEventListener('abort', () => { held.delete(resource); aborted++ }, { once: true })
      const fail = () => { throw new Error(input.code) }
      if (input.fail === 'start') fail()
      return {
        write() { if (input.fail === 'write') fail() },
        finish() {
          if (input.fail === 'finish') fail()
          committed++
          call.emit({ held: held.size, aborted, committed }, new Uint8Array([1, 2, 3, 4]))
          held.delete(resource)
        },
      }
    },
  }
}
`)
})
afterAll(async () => {
  if (root)
    await rm(root, { recursive: true, force: true })
})

it('reads bounded file initialization on the Darwin worker branch without enlarging binary frame limits', async () => {
  const initialization = { configuration: {}, resources: { model: root }, resourceFiles: { model: Object.fromEntries(Array.from({ length: 700 }, (_, index) => [`language-${index}.dict`, `${root}/${'nested/'.repeat(16)}language-${index}.dict`])) } }
  const json = JSON.stringify(initialization)
  expect(json.length).toBeGreaterThan(65536)
  await writeInferenceInitialization(root, initialization)
  const backend = join(root, 'mapped-backend.mjs')
  await writeFile(backend, `import { createHash } from 'node:crypto'; export function initialize(context) { return { start(_capability, _input, call) { return { finish() { call.emit({ sha256: createHash('sha256').update(JSON.stringify(context)).digest('hex') }, new Uint8Array([0, 255, 128, 10])) } } } } }`)
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,Object.defineProperty(process,"platform",{value:"darwin"})', join(root, 'worker.mjs'), backend], { stdio: 'pipe' })
  const worker = Reflect.construct(NativeInferenceProcess, [child]) as NativeInferenceProcess
  try {
    await writeInferenceFrame(child.stdin, { type: 'initialize' })
    const events: unknown[] = []
    await worker.invoke(invocation({
      event(data, bytes) { events.push({ data, bytes: [...bytes] }) },
    }))
    expect(events).toEqual([{ data: { sha256: createHash('sha256').update(json).digest('hex') }, bytes: [0, 255, 128, 10] }])
  }
  finally { await worker.stop() }
})

it.each(['start', 'write', 'finish'] as const)('aborts failed %s resources without committing them and reuses the same worker', async (fail) => {
  const child = spawn(process.execPath, [join(root, 'worker.mjs'), join(root, 'backend.mjs')], { stdio: 'pipe' })
  const worker = Reflect.construct(NativeInferenceProcess, [child]) as NativeInferenceProcess
  try {
    await writeInferenceFrame(child.stdin, { type: 'initialize', data: {} })
    const code = fail === 'write' ? 'private backend failure' : 'EXTENSION_INFERENCE_CONTEXT_TOO_LARGE'
    await expect(worker.invoke(invocation({
      input: { fail, code },
      chunks: (async function* () { yield new Uint8Array(4) })(),
    }))).rejects.toThrow(fail === 'write' ? 'EXTENSION_INFERENCE_BACKEND_FAILED' : code)
    expect(worker.stopped).toBe(false)
    expect(worker.cancelling).toBe(0)
    const events: unknown[] = []
    await worker.invoke(invocation({
      event(data, bytes) { events.push({ data, bytes: [...bytes] }) },
    }))
    expect(events).toEqual([{ data: { held: 1, aborted: 1, committed: 1 }, bytes: [1, 2, 3, 4] }])
    expect(worker.stopped).toBe(false)
  }
  finally {
    await worker.stop()
  }
  expect(worker.stopped).toBe(true)
})
