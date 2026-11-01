import type { SpawnWslHelper } from '../wslProcess'
import { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { WSL_HELPER_VERSION } from '../wslHelperScript'

export const distribution = 'Ubuntu-24.04'

export type Helper = ReturnType<SpawnWslHelper>

// Runs `wsl.exe -d <distribution> --exec python3 -u -c <script> <idle>` as a local python3, so the real helper script
// and the real rg, find and bash are exercised. They are Linux tools, hence the skips elsewhere.
export function localHelper(started: Helper[], env?: NodeJS.ProcessEnv): SpawnWslHelper {
  return (_executable, args) => {
    const [, , , program, ...rest] = args
    const child = spawn(program!, rest, { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env })
    started.push(child)
    return child
  }
}

const python = process.platform !== 'win32' ? spawnSync('python3', ['-c', 'import asyncio; asyncio.get_running_loop; import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)']) : undefined
export const hasHelperPython = python?.status === 0
export const hasBash = process.platform !== 'win32' && spawnSync('bash', ['-c', 'true']).status === 0
export const hasHelperStack = hasHelperPython && spawnSync('rg', ['--version']).status === 0 && spawnSync('find', ['.', '-maxdepth', '0', '-printf', 'x']).status === 0

export interface FakeRequest {
  id: number
  op?: string
  program?: string
  args?: string[]
  cwd?: string
  command?: string
}

// A helper that is scripted rather than run: it writes frames and closes when the test says so.
export class FakeHelper {
  readonly child: Helper
  readonly requests: FakeRequest[] = []
  readonly #stdout = new PassThrough()
  readonly #stderr = new PassThrough()
  readonly #stdin = new PassThrough()

  constructor(options: { ready?: unknown, onRequest?: (request: FakeRequest, helper: FakeHelper) => void } = {}) {
    this.child = Object.assign(new EventEmitter(), { stdout: this.#stdout, stderr: this.#stderr, stdin: this.#stdin, kill: () => this.close(null) }) as unknown as Helper
    let buffer = ''
    this.#stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        this.requests.push(request)
        options.onRequest?.(request, this)
      }
    })
    this.#stdin.on('end', () => this.close(0))
    if (options.ready !== null)
      setImmediate(() => this.frame(options.ready ?? { t: 'ready', v: WSL_HELPER_VERSION }))
  }

  frame(value: unknown) {
    this.#stdout.write(`${JSON.stringify(value)}\n`)
  }

  out(id: number, data: string) {
    this.frame({ id, t: 'o', d: Buffer.from(data).toString('base64') })
  }

  err(id: number, data: string) {
    this.frame({ id, t: 'e', d: Buffer.from(data).toString('base64') })
  }

  stderr(data: string) {
    this.#stderr.write(data)
  }

  close(code: number | null) {
    setImmediate(() => this.child.emit('close', code))
  }
}

export function sequence(...helpers: FakeHelper[]) {
  const calls: string[][] = []
  const spawnProcess: SpawnWslHelper = (_executable, args) => {
    calls.push(args)
    const helper = helpers[calls.length - 1]
    if (!helper)
      throw new Error('No scripted helper left')
    return helper.child
  }
  return { spawnProcess, calls }
}
