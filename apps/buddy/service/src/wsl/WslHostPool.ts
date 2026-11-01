import type { SearchCollector, SpawnWslHelper, WslSearchProcess } from './wslProcess'
import { Buffer } from 'node:buffer'
import { WSL_HELPER_SCRIPT, WSL_HELPER_VERSION } from './wslHelperScript'
import { collectSearch, decodeDiagnostic, relayError, runWslSearch, spawnWslHelper, wslExecutable } from './wslProcess'

const START_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 1_000
// How long a cancelled command is given to confirm that it ended before the call gives up waiting.
const CANCEL_GRACE_MS = 2_000
const UNAVAILABLE_RETRY_MS = 5 * 60_000
const DEFAULT_IDLE_SECONDS = 300
const MAX_ACTIVE = 64

export interface WslHostPoolOptions {
  /** Seconds without a request after which the helper in the distribution exits. */
  idleSeconds?: number
  /** Replaces the wsl.exe launch of the helper, for tests. */
  spawnProcess?: SpawnWslHelper
  now?: () => number
}

export interface WslShellRequest {
  distribution: string
  /** Linux path of the directory the command runs in. */
  cwd: string
  command: string
  signal?: AbortSignal
  /** Seconds. */
  timeout?: number
  /** Combined stdout and stderr, in the order the command wrote them. */
  onData: (data: Buffer) => void
}

export type RunWslShell = (request: WslShellRequest) => Promise<{ exitCode: number }>

interface HostOptions {
  idleSeconds: number
  spawnProcess: SpawnWslHelper
  now: () => number
}

// The helper went away (wsl --shutdown, an idle exit, a crash). `received`: some output of the request had arrived.
// `sent`: the request had reached the helper, so a command may already have run, in whole or in part.
class HelperClosedError extends Error {
  readonly received: boolean
  readonly sent: boolean

  constructor(received: boolean, sent = true) {
    super('The WSL helper stopped during the search; run it again')
    this.name = 'HelperClosedError'
    this.received = received
    this.sent = sent
  }
}

// What the connection needs from whoever is waiting on a request; a search collector is one.
interface FrameHandler {
  readonly received: boolean
  stdout: (chunk: Buffer) => void
  stderr: (chunk: Buffer) => void
  exit: (code: number | null, reason?: string) => void
  fail: (error: Error) => void
}

interface Frame {
  t?: string
  v?: number
  id?: number
  d?: string
  code?: number | null
  err?: string
}

// One helper process: `wsl.exe -d <distribution> --exec python3 -u -c <script> <idle>`, kept open and shared by every request.
class HelperConnection {
  readonly closed = Promise.withResolvers<void>()
  alive = true
  readonly #child: ReturnType<SpawnWslHelper>
  readonly #ready = Promise.withResolvers<void>()
  readonly #requests = new Map<number, FrameHandler>()
  #buffer = ''
  #nextId = 1
  #stderr = Buffer.alloc(0)

  constructor(distribution: string, options: HostOptions) {
    this.#child = options.spawnProcess(wslExecutable(), ['-d', distribution, '--exec', 'python3', '-u', '-c', WSL_HELPER_SCRIPT, String(options.idleSeconds)])
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk: string) => this.#read(chunk))
    this.#child.stderr.on('data', (chunk: Buffer) => {
      if (this.#stderr.length < 4096)
        this.#stderr = Buffer.concat([this.#stderr, chunk])
    })
    // A write to a helper that already exited surfaces as EPIPE here and as `close`; close settles the requests.
    this.#child.stdin.on('error', () => {})
    this.#child.once('error', error => this.#end(error))
    this.#child.once('close', () => this.#end())
    // Nobody waits on `ready` once the helper is running, so a later rejection must not go unhandled.
    this.#ready.promise.catch(() => {})
  }

  async ready(): Promise<void> {
    const timer = setTimeout(() => this.#ready.reject(new Error('The WSL helper did not start in time')), START_TIMEOUT_MS)
    try {
      await this.#ready.promise
    }
    finally {
      clearTimeout(timer)
    }
  }

  search(request: WslSearchProcess): Promise<void> {
    if (!this.alive)
      return Promise.reject(new HelperClosedError(false, false))
    if (this.#requests.size >= MAX_ACTIVE)
      return Promise.reject(new Error('Too many searches are running in WSL at once'))
    const id = this.#nextId++
    const collector: SearchCollector = collectSearch(request, () => this.#send({ op: 'cancel', id }))
    this.#requests.set(id, collector)
    this.#send({ id, program: request.program, args: request.args })
    return collector.done.finally(() => this.#requests.delete(id))
  }

  // Runs `bash -lc` in the distribution. Unlike a search it has effects, so it is never started again on its own, and
  // an abort or a timeout is only reported once the helper confirms that the command ended (or gives up waiting).
  async shell(request: WslShellRequest): Promise<{ exitCode: number }> {
    if (!this.alive)
      throw new HelperClosedError(false, false)
    if (this.#requests.size >= MAX_ACTIVE)
      throw new Error('Too many commands are running in WSL at once')
    request.signal?.throwIfAborted()
    const id = this.#nextId++
    const exit = Promise.withResolvers<{ code: number | null, reason?: string }>()
    let received = false
    this.#requests.set(id, {
      get received() {
        return received
      },
      stdout(chunk) {
        received = true
        request.onData(chunk)
      },
      stderr: chunk => request.onData(chunk),
      exit: (code, reason) => exit.resolve({ code, reason }),
      fail: error => exit.reject(error),
    })
    let stopped: Error | undefined
    let grace: ReturnType<typeof setTimeout> | undefined
    const stop = (error: Error) => {
      if (stopped)
        return
      stopped = error
      this.#send({ op: 'cancel', id })
      grace = setTimeout(() => exit.resolve({ code: null, reason: 'UNCONFIRMED' }), CANCEL_GRACE_MS)
    }
    const onAbort = () => stop(new Error('aborted'))
    const timer = request.timeout === undefined ? undefined : setTimeout(() => stop(new Error(`timeout:${request.timeout}`)), request.timeout * 1000)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      this.#send({ id, op: 'shell', cwd: request.cwd, command: request.command })
      let outcome: { code: number | null, reason?: string }
      try {
        outcome = await exit.promise
      }
      catch (error) {
        if (stopped)
          throw stopped
        throw error instanceof HelperClosedError ? new Error('The WSL helper stopped while the command was running; it may have run only in part') : error
      }
      if (stopped)
        throw stopped
      if (outcome.reason === 'CWD')
        throw new Error(`Working directory does not exist: ${request.cwd}\nCannot execute bash commands.`)
      if (outcome.reason === 'ENOENT')
        throw new Error(`bash is not installed in the WSL distribution ${request.distribution}`)
      if (outcome.reason)
        throw new Error(`bash could not be started in the WSL distribution ${request.distribution}`)
      // A signal-killed command has no exit code; the shell convention is 128 plus the signal number.
      const code = outcome.code ?? 1
      return { exitCode: code < 0 ? 128 - code : code }
    }
    finally {
      clearTimeout(timer)
      clearTimeout(grace)
      request.signal?.removeEventListener('abort', onAbort)
      this.#requests.delete(id)
    }
  }

  // Closes stdin so the helper ends its programs and exits; kills it if it does not.
  async close(): Promise<void> {
    if (!this.alive)
      return
    this.#child.stdin.end()
    const timer = setTimeout(() => this.#child.kill('SIGKILL'), STOP_TIMEOUT_MS)
    try {
      await this.closed.promise
    }
    finally {
      clearTimeout(timer)
    }
  }

  #send(message: object): void {
    if (this.alive)
      this.#child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #read(chunk: string): void {
    this.#buffer += chunk
    for (let end = this.#buffer.indexOf('\n'); end !== -1; end = this.#buffer.indexOf('\n')) {
      const line = this.#buffer.slice(0, end)
      this.#buffer = this.#buffer.slice(end + 1)
      try {
        this.#handle(JSON.parse(line) as Frame)
      }
      catch {
        // A line that is not a frame cannot belong to any request; the helper only ever writes frames.
      }
    }
  }

  #handle(frame: Frame): void {
    if (frame.t === 'ready') {
      if (frame.v === WSL_HELPER_VERSION)
        this.#ready.resolve()
      else
        this.#ready.reject(new Error(`The WSL helper speaks protocol ${frame.v}, not ${WSL_HELPER_VERSION}`))
      return
    }
    const handler = frame.id === undefined ? undefined : this.#requests.get(frame.id)
    if (!handler)
      return
    if (frame.t === 'o')
      handler.stdout(Buffer.from(frame.d ?? '', 'base64'))
    else if (frame.t === 'e')
      handler.stderr(Buffer.from(frame.d ?? '', 'base64'))
    else if (frame.t === 'exit')
      handler.exit(frame.code ?? null, typeof frame.code === 'number' ? undefined : frame.err ?? 'SPAWN')
  }

  #end(error?: Error): void {
    if (!this.alive)
      return
    this.alive = false
    this.#ready.reject(error ?? new Error(relayError(this.#stderr) ?? (decodeDiagnostic(this.#stderr) || 'The WSL helper exited before it was ready')))
    for (const handler of this.#requests.values())
      handler.fail(new HelperClosedError(handler.received))
    this.#requests.clear()
    this.closed.resolve()
  }
}

// The helper of one distribution: started on first use, started again after it ends, and marked unavailable for a while
// when it cannot start (no python3, an old Python, a protocol mismatch) so that searches use one wsl.exe each instead.
class WslHost {
  #connection: Promise<HelperConnection> | undefined
  #unavailableUntil = 0
  #reason: string | undefined
  readonly #distribution: string
  readonly #options: HostOptions

  constructor(distribution: string, options: HostOptions) {
    this.#distribution = distribution
    this.#options = options
  }

  /** Why the helper could not start the last time it was tried. */
  get reason(): string | undefined {
    return this.#reason
  }

  async acquire(): Promise<HelperConnection | null> {
    if (this.#options.now() < this.#unavailableUntil)
      return null
    // A second pass restarts a helper that ended since the last request.
    for (let pass = 0; pass < 2; pass++) {
      const starting = this.#connection ??= this.#start()
      try {
        const connection = await starting
        if (connection.alive)
          return connection
      }
      catch (error) {
        this.#reason = error instanceof Error ? error.message : String(error)
        this.#unavailableUntil = this.#options.now() + UNAVAILABLE_RETRY_MS
        if (this.#connection === starting)
          this.#connection = undefined
        return null
      }
      if (this.#connection === starting)
        this.#connection = undefined
    }
    return null
  }

  async close(): Promise<void> {
    const starting = this.#connection
    this.#connection = undefined
    const connection = await starting?.catch(() => undefined)
    await connection?.close()
  }

  async #start(): Promise<HelperConnection> {
    const connection = new HelperConnection(this.#distribution, this.#options)
    try {
      await connection.ready()
    }
    catch (error) {
      await connection.close()
      throw error
    }
    return connection
  }
}

// Runs searches and shell commands in WSL through one resident helper per distribution. A search costs about 10 ms
// instead of the 200 ms of a wsl.exe start, and still works without the helper: when it cannot run, each search starts
// its own wsl.exe. A shell command needs the helper, because it relies on the helper's login PATH and supervision.
export class WslHostPool {
  readonly #hosts = new Map<string, WslHost>()
  readonly #options: HostOptions

  constructor(options: WslHostPoolOptions = {}) {
    this.#options = { idleSeconds: options.idleSeconds ?? DEFAULT_IDLE_SECONDS, now: options.now ?? Date.now, spawnProcess: options.spawnProcess ?? spawnWslHelper }
  }

  readonly run = async (request: WslSearchProcess): Promise<void> => {
    request.signal?.throwIfAborted()
    const host = this.#host(request.distribution)
    for (let attempt = 0; ; attempt++) {
      const connection = await host.acquire()
      if (!connection)
        return runWslSearch(request)
      try {
        return await connection.search(request)
      }
      catch (error) {
        // A search is read-only: when the helper went away before it produced anything, it is started again once.
        if (error instanceof HelperClosedError && !error.received && attempt === 0)
          continue
        throw error
      }
    }
  }

  readonly shell: RunWslShell = async (request) => {
    request.signal?.throwIfAborted()
    const host = this.#host(request.distribution)
    for (let attempt = 0; ; attempt++) {
      const connection = await host.acquire()
      if (!connection)
        throw new Error(`Commands cannot run in the WSL distribution ${request.distribution}: its helper did not start${host.reason ? ` (${host.reason})` : ''}. Python 3.7 or later (python3) must be installed there, for example: sudo apt install python3`)
      try {
        return await connection.shell(request)
      }
      catch (error) {
        // Only a command that never reached the helper may be sent again.
        if (error instanceof HelperClosedError && !error.sent && attempt === 0)
          continue
        throw error
      }
    }
  }

  async dispose(): Promise<void> {
    const hosts = [...this.#hosts.values()]
    this.#hosts.clear()
    await Promise.all(hosts.map(host => host.close()))
  }

  #host(distribution: string): WslHost {
    let host = this.#hosts.get(distribution)
    if (!host)
      this.#hosts.set(distribution, host = new WslHost(distribution, this.#options))
    return host
  }
}
