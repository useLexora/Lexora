import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(new URL('../../../apps/buddy/package.json', import.meta.url))
const { zipSync } = require('fflate/node')

export const workerProbeId = 'tests.worker-boundaries'

const addWasm = Uint8Array.from([
  0,
  97,
  115,
  109,
  1,
  0,
  0,
  0,
  1,
  7,
  1,
  96,
  2,
  127,
  127,
  1,
  127,
  3,
  2,
  1,
  0,
  7,
  7,
  1,
  3,
  97,
  100,
  100,
  0,
  0,
  10,
  9,
  1,
  7,
  0,
  32,
  0,
  32,
  1,
  106,
  11,
])
const busyWasm = Uint8Array.from([
  0,
  97,
  115,
  109,
  1,
  0,
  0,
  0,
  1,
  4,
  1,
  96,
  0,
  0,
  3,
  2,
  1,
  0,
  7,
  8,
  1,
  4,
  115,
  112,
  105,
  110,
  0,
  0,
  10,
  9,
  1,
  7,
  0,
  3,
  64,
  12,
  0,
  11,
  11,
])

function declarations(...functions) {
  return functions.map(fn => fn.toString()).join('\n')
}

function command(id, name, title = name) {
  return { id: `${id}.${name}`, title, slash: { name } }
}

async function archive(directory, name, files) {
  await fs.mkdir(directory, { recursive: true })
  const output = path.join(directory, `${name}.lexora-extension`)
  await fs.writeFile(output, zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, typeof value === 'string' ? Buffer.from(value) : value])), { level: 6 }))
  return output
}

function requestWorker(worker, data, transfer = [], signal) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    let timer
    function finish(error, value) {
      clearTimeout(timer)
      worker.removeEventListener('message', message)
      worker.removeEventListener('error', failed)
      signal?.removeEventListener('abort', aborted)
      error ? reject(error) : resolve(value)
    }
    function message({ data }) {
      if (data.requestId === requestId)
        finish(data.error ? new Error(data.error) : null, data.value)
    }
    function failed(event) {
      finish(new Error(`Worker failed: ${event.message || 'no error details'} (${event.filename || 'unknown source'}:${event.lineno || 0})`))
    }
    function aborted() {
      finish(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    timer = setTimeout(() => {
      worker.terminate()
      finish(new Error(`Worker did not reply to ${data.action} within 15 seconds`))
    }, 15000)
    worker.addEventListener('message', message)
    worker.addEventListener('error', failed)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) {
      aborted()
      return
    }
    try {
      worker.postMessage({ ...data, requestId }, transfer)
    }
    catch (error) {
      finish(error)
    }
  })
}

export async function writeWorkerProbe(directory) {
  const id = workerProbeId
  const manifest = {
    schemaVersion: 1,
    format: 'compiled',
    id,
    name: 'Worker boundary fixture',
    version: '1.0.0',
    apiVersion: 4,
    engines: { lexora: '>=0.15.0 <1.0.0' },
    entry: 'host.js',
    contributes: {
      commands: ['open', 'describe', 'security', 'entries', 'start', 'status', 'wasm', 'startup'].map(name => command(id, name)),
      views: [{ id: `${id}.view`, title: 'Worker 验收', entry: 'view.js', resource: 'none' }],
    },
  }
  const helpers = declarations(requestWorker, scriptSecurity, networkSecurity, securityProbe, wasmProbe, entryProbe, workerApi)
  const worker = declarations(scriptSecurity, networkSecurity, probeWorker)
  return {
    id,
    archive: await archive(directory, 'worker-boundaries', {
      'extension.json': JSON.stringify(manifest),
      'host.js': `${helpers}\nexport const activate = context => (${probeHost.toString()})(context, import.meta.url);\n`,
      'view.js': `${helpers}\nexport const render = (context, container) => (${probeView.toString()})(context, container, import.meta.url);\n`,
      'worker-classic.js': `${worker}\nprobeWorker({ type: 'classic', dependency: null, moduleUrl: null });\n`,
      'worker-module.js': `import { dependency } from './module-data.js';\nawait new Promise(resolve => setTimeout(resolve, 80));\n${worker}\nprobeWorker({ type: 'module', dependency, moduleUrl: import.meta.url });\n`,
      'module-data.js': 'export const dependency = \'package-relative-module\'\n',
      ...Object.fromEntries(['property', 'listener'].map(mode => [`startup-${mode}.js`, `await (${startupWorker.toString()})(${JSON.stringify(mode)});\n`])),
      'add.wasm': addWasm,
      'busy.wasm': busyWasm,
    }),
  }
}

async function startupWorker(mode) {
  let initialized = false
  let complete
  const configured = new Promise(resolve => complete = resolve)
  const order = []
  await new Promise(resolve => setTimeout(resolve, 80))
  const receive = async ({ data, ports }) => {
    if (data.action === 'initialize') {
      await Promise.resolve()
      initialized = true
      order.push('initialized')
      complete()
      globalThis.postMessage({ requestId: data.requestId, value: 'initialized' })
    }
    else {
      ports[0].postMessage({ initialized, order: [...order, 'query'], byte: new Uint8Array(data.buffer)[0] })
    }
  }
  if (mode === 'property')
    globalThis.onmessage = receive
  else
    globalThis.addEventListener('message', receive, { capture: true })
  await configured
  order.push('module-resumed')
}

function scriptSecurity() {
  const denied = (callback) => {
    try {
      callback()
      return false
    }
    catch (error) {
      return error.name === 'EvalError' && /unsafe-eval|Content Security Policy/i.test(error.message)
    }
  }
  return {
    evalDenied: denied(() => Reflect.get(globalThis, 'eval')('1 + 1')),
    functionDenied: denied(() => new globalThis.Function('return 2')()),
    node: typeof Reflect.get(globalThis, 'process'),
    require: typeof globalThis.require,
    desktop: typeof globalThis.lexoraDesktop,
  }
}

async function networkSecurity() {
  let listener
  let timer
  const violation = new Promise((resolve) => {
    listener = (event) => {
      if (event.effectiveDirective === 'connect-src')
        resolve(event.effectiveDirective)
    }
    globalThis.addEventListener('securitypolicyviolation', listener)
    timer = setTimeout(resolve, 2000, null)
  })
  let directDenied = false
  try {
    await fetch('https://worker-fixture.invalid/unapproved')
  }
  catch {
    directDenied = true
  }
  const directive = await violation
  clearTimeout(timer)
  globalThis.removeEventListener('securitypolicyviolation', listener)
  return { directDenied, directive }
}

async function securityProbe(context) {
  const network = await networkSecurity()
  let brokerError = null
  try {
    await context.network.get('https://worker-fixture.invalid/unapproved')
  }
  catch (error) {
    brokerError = String(error)
  }
  let parentDenied = null
  if (globalThis.parent !== globalThis) {
    try {
      void globalThis.parent.document.body
      parentDenied = false
    }
    catch {
      parentDenied = true
    }
  }
  return { ...scriptSecurity(), ...network, brokerError, parentDenied, origin: globalThis.origin }
}

async function wasmProbe(baseUrl) {
  const url = new URL('add.wasm', baseUrl)
  const response = await fetch(url)
  const bytes = await response.arrayBuffer()
  const binary = await WebAssembly.instantiate(bytes)
  const streamingResponse = await fetch(url)
  const mime = streamingResponse.headers.get('content-type')
  const streaming = await WebAssembly.instantiateStreaming(streamingResponse)
  return { binary: binary.instance.exports.add(19, 23), streaming: streaming.instance.exports.add(19, 23), mime, valid: WebAssembly.validate(bytes) }
}

async function entryProbe(context, baseUrl, foreign) {
  const cases = {
    network: 'https://worker-fixture.invalid/worker.js',
    filesystem: 'file:///lexora-worker-fixture-forbidden.js',
    runtime: new URL('../__view.js', baseUrl).href,
    encodedEscape: '%2e%2e/__host.js',
    ...(foreign ? { foreign } : {}),
  }
  const results = {}
  for (const [name, entry] of Object.entries(cases)) {
    try {
      const worker = await context.workers.create(entry)
      worker.terminate()
      results[name] = { rejected: false }
    }
    catch (error) {
      results[name] = { rejected: true, error: String(error) }
    }
  }
  const controller = new AbortController()
  controller.abort()
  try {
    const worker = await context.workers.create('worker-classic.js', { signal: controller.signal })
    worker.terminate()
    results.aborted = { rejected: false }
  }
  catch (error) {
    results.aborted = { rejected: true, error: error.name }
  }
  return results
}

function probeWorker(metadata) {
  globalThis.onmessage = async ({ data }) => {
    const reply = value => globalThis.postMessage({ requestId: data.requestId, value })
    try {
      if (data.action === 'echo') {
        const bytes = new Uint8Array(data.buffer)
        const original = Array.from(bytes)
        bytes[0] += 1
        globalThis.postMessage({
          requestId: data.requestId,
          value: {
            ...metadata,
            ...scriptSecurity(),
            ...await networkSecurity(),
            original,
            buffer: data.buffer,
            circular: data.graph.self === data.graph,
            url: globalThis.location.href,
            name: globalThis.name,
          },
        }, [data.buffer])
      }
      else if (data.action === 'busy') {
        const { instance } = await WebAssembly.instantiate(data.wasm)
        reply({ phase: 'busy', url: globalThis.location.href, name: globalThis.name, ...metadata })
        instance.exports.spin()
      }
      else if (data.action === 'tick') {
        let sequence = 0
        const tick = () => globalThis.postMessage({ kind: 'tick', sequence: ++sequence })
        reply({ url: globalThis.location.href, name: globalThis.name })
        tick()
        setInterval(tick, 50)
      }
    }
    catch (error) {
      globalThis.postMessage({ requestId: data.requestId, error: String(error) })
    }
  }
}

function workerApi(context, baseUrl) {
  let busy
  let ticks = 0
  let ticker = null
  const instance = crypto.randomUUID()
  async function create(type, options = {}) {
    return type === 'module'
      ? context.workers.create(new URL('worker-module.js', baseUrl), { ...options, type: 'module' })
      : context.workers.create('worker-classic.js', options)
  }
  return {
    describe: () => ({ instance, entry: new URL('worker-classic.js', baseUrl).href, signal: context.signal instanceof AbortSignal, aborted: context.signal.aborted }),
    security: () => securityProbe(context),
    wasm: () => wasmProbe(baseUrl),
    entries: foreign => entryProbe(context, baseUrl, foreign),
    async startup(mode) {
      const worker = await context.workers.create(`startup-${mode}.js`, { type: 'module', signal: context.signal })
      const channel = new MessageChannel()
      const buffer = Uint8Array.of(42).buffer
      try {
        const initialized = requestWorker(worker, { action: 'initialize' }, [], context.signal)
        const queried = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Worker startup timed out')), 10000)
          channel.port1.onmessage = ({ data }) => {
            clearTimeout(timer)
            resolve(data)
          }
        })
        worker.postMessage({ action: 'query', buffer }, [buffer, channel.port2])
        const results = await Promise.all([initialized, queried])
        return { initialized: results[0], query: results[1], detached: buffer.byteLength === 0 }
      }
      finally {
        worker.terminate()
        channel.port1.close()
        channel.port2.close()
      }
    },
    async run(type) {
      const worker = await create(type, { name: `clone-${type}` })
      try {
        const buffer = Uint8Array.from([7, 11, 19, 255]).buffer
        const graph = {}
        graph.self = graph
        const pending = requestWorker(worker, { action: 'echo', buffer, graph }, [buffer], context.signal)
        const detached = buffer.byteLength === 0
        const value = await pending
        return {
          ...value,
          native: worker instanceof Worker,
          detached,
          buffer: Array.from(new Uint8Array(value.buffer)),
        }
      }
      finally {
        worker.terminate()
      }
    },
    async missing() {
      const worker = await context.workers.create('missing-entry.js', { type: 'module', name: 'missing-entry' })
      try {
        return await requestWorker(worker, { action: 'echo' }, [], context.signal)
      }
      finally {
        worker.terminate()
      }
    },
    async startBusy(type) {
      busy?.abort()
      busy = new AbortController()
      const worker = await create(type, { name: `busy-${type}`, signal: busy.signal })
      const wasm = await fetch(new URL('busy.wasm', baseUrl)).then(response => response.arrayBuffer())
      return requestWorker(worker, { action: 'busy', wasm }, [wasm], busy.signal)
    },
    cancelBusy() {
      busy?.abort()
      return { aborted: busy?.signal.aborted === true, ownerAborted: context.signal.aborted }
    },
    async start() {
      if (ticker)
        throw new Error('Ticker already started')
      const worker = await create('classic', { name: `owner-${instance}` })
      worker.addEventListener('message', ({ data }) => {
        if (data.kind === 'tick')
          ticks = data.sequence
      })
      ticker = await requestWorker(worker, { action: 'tick' }, [], context.signal)
      return { instance, ...ticker }
    },
    status: () => ({ instance, ticks, ticker }),
  }
}

function probeHost(context, baseUrl) {
  const api = workerApi(context, baseUrl)
  context.signal.addEventListener('abort', () => console.info(`extension-worker-owner-aborted:${api.describe().instance}`), { once: true })
  for (const name of ['describe', 'security', 'entries', 'start', 'status', 'wasm', 'startup']) {
    context.subscriptions.add(context.commands.register(`${context.extension.id}.${name}`, ({ arguments: input }) => api[name](input || undefined)))
  }
  context.subscriptions.add(context.commands.register(`${context.extension.id}.open`, () => context.views.open(`${context.extension.id}.view`)))
}

function probeView(context, container, baseUrl) {
  const api = workerApi(context, baseUrl)
  globalThis.workerFixture = api
  container.dataset.workerProbe = 'true'
  container.style.cssText = 'padding:24px;color:var(--lexora-text);font:14px system-ui'
  container.innerHTML = '<h1>Worker 验收</h1><label>响应检查 <input aria-label="响应检查"></label><output aria-label="输入响应"></output><button>取消忙循环</button><p role="status">就绪</p>'
  const input = container.querySelector('input')
  input.oninput = () => container.querySelector('output').textContent = input.value
  container.querySelector('button').onclick = () => {
    const result = api.cancelBusy()
    container.querySelector('[role=status]').textContent = result.aborted && !result.ownerAborted ? 'Worker 已取消，视图仍运行' : '取消失败'
  }
}
