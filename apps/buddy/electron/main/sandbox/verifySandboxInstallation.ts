import type { MessagePort } from 'node:worker_threads'
import type { SandboxHostOptions } from './registerSandboxHostRpc'
import { Buffer } from 'node:buffer'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { MessageChannel } from 'node:worker_threads'
import { currentPlatform } from '../../../platform/currentPlatform'
import { RuntimeRpcPeer } from '../../../platform/ipc/runtimeRpcPeer'
import { checkSandboxEnvironment } from '../../../platform/process/sandboxDependencies'
import { ShellSandboxClient } from '../../../service/src/sandbox/ShellSandboxClient'
import { ShellSandboxError } from '../../../shared/permissions/shellSandbox'
import { isWindows } from '../../../shared/platform'
import { registerSandboxHostRpc } from './registerSandboxHostRpc'

export async function verifySandboxInstallation(options: SandboxHostOptions, scale = false): Promise<{ preparationMs: number, firstCommandMs: number, repeatedRpcMs: number[] } | undefined> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'lexora-installed-sandbox-')))
  const workspace = join(directory, '工作区 Space')
  const channel = new MessageChannel()
  const createPeer = (port: MessagePort) => new RuntimeRpcPeer({
    transport: {
      postMessage: message => port.postMessage(message),
      subscribe(listener) {
        port.on('message', listener)
        return () => port.off('message', listener)
      },
    },
  })
  const host = createPeer(channel.port1)
  const runtime = createPeer(channel.port2)
  const disposeHost = registerSandboxHostRpc(host, options)
  const client = new ShellSandboxClient(runtime)
  const measurements: number[] = []
  let preparationMs = 0
  let firstCommandMs = 0
  const events: { elapsed: number, phase: string, started: boolean, process?: string }[] = []
  let commandNumber = 0
  let startedAt = performance.now()
  const hostObservation = disposeHost.onDidChange((event) => {
    events.push({ elapsed: performance.now() - startedAt, phase: `host.${event.kind}`, started: false })
  })
  const observation = client.onDidChange((change) => {
    if (change.kind !== 'backend')
      return
    const state = change.event.snapshot
    events.push({ elapsed: performance.now() - startedAt, phase: state.phase, started: state.started, process: state.process?.phase })
    if (events.length > 16)
      events.shift()
  })
  const quote = (path: string) => `'${path.replaceAll('\'', '\'\'')}'`
  const originalPath = process.env.PATH
  const powershell = currentPlatform.shell === 'powershell'
  const execute = async (command: string, readOnly = false, approve = false, timeout = 10, cancellation?: AbortController) => {
    commandNumber++
    startedAt = performance.now()
    events.length = 0
    const output: Buffer[] = []
    const result = await client.exec({ command, cwd: workspace, roots: [workspace], workspaceRoots: [workspace], resourceReadRoots: [], additionalDirectories: [], readOnly, timeout }, {
      signal: cancellation?.signal,
      onData: (data) => {
        output.push(data)
        if (cancellation && Buffer.concat(output).includes('CANCEL_READY'))
          cancellation.abort()
      },
    }, async () => approve)
    return { ...result, output: Buffer.concat(output).toString('utf8') }
  }
  const absent = async (path: string) => {
    if (await access(path).then(() => true, () => false))
      throw new Error(`Installed sandbox wrote a forbidden fixture: ${path}`)
  }
  try {
    await mkdir(workspace)
    const status = await checkSandboxEnvironment(options)
    if (isWindows(currentPlatform.id) && status === 'needs_setup' && process.env.LEXORA_DESKTOP_SMOKE_REQUIRE_SANDBOX !== '1') {
      try {
        await execute('Set-Content -LiteralPath forbidden -Value changed')
        throw new Error('Unconfigured Windows sandbox executed a command')
      }
      catch (error) {
        if (!(error instanceof ShellSandboxError) || error.code !== 'SANDBOX_UNAVAILABLE')
          throw error
      }
      await absent(join(workspace, 'forbidden'))
      return
    }
    if (status !== 'available')
      throw new Error(`Installed sandbox is unavailable: ${status}`)
    if (scale) {
      const toolchain = join(directory, 'toolchain')
      await mkdir(toolchain)
      for (const [root, count] of [[toolchain, 50_000], [workspace, 5_000]] as const) {
        for (let offset = 0; offset < count; offset += 100)
          await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(root, `fixture-${offset + index}`), 'fixture')))
      }
      process.env.PATH = `${toolchain}${powershell ? ';' : ':'}${originalPath ?? ''}`
    }
    const preparationStarted = performance.now()
    await client.prepare([workspace])
    preparationMs = performance.now() - preparationStarted
    if (scale && preparationMs > 30_000)
      throw new Error(`Installed sandbox exceeded its workspace preparation budget: ${preparationMs} ms`)
    await writeFile(join(workspace, '.env'), 'synthetic-secret')
    const firstCommandStarted = performance.now()
    const write = await execute(powershell ? 'Set-Content -LiteralPath result -Value ready -NoNewline' : 'printf ready > result')
    firstCommandMs = performance.now() - firstCommandStarted
    if (scale && firstCommandMs > 5_000)
      throw new Error(`Installed sandbox exceeded its first prepared command budget: ${firstCommandMs} ms`)
    if (write.exitCode !== 0 || await readFile(join(workspace, 'result'), 'utf8') !== 'ready')
      throw new Error('Installed sandbox could not write its authorized workspace')
    const secret = await execute(powershell ? 'Get-Content -LiteralPath .env -ErrorAction Stop' : 'cat .env')
    if (secret.exitCode !== 0 || !secret.output.includes('synthetic-secret'))
      throw new Error('Installed sandbox could not read ordinary workspace content')
    const protectedFile = join(options.buddyHome, 'sandbox-protected-fixture')
    await writeFile(protectedFile, 'PRIVATE_FIXTURE')
    try {
      const protectedRead = await execute(powershell ? `Get-Content -LiteralPath ${quote(protectedFile)} -ErrorAction Stop` : `cat ${quote(protectedFile)}`)
      if (protectedRead.exitCode === 0 || protectedRead.output.includes('PRIVATE_FIXTURE'))
        throw new Error('Installed sandbox exposed application-private data')
    }
    finally { await rm(protectedFile, { force: true }) }
    const readOnly = await execute(powershell ? 'Set-Content -LiteralPath forbidden -Value changed -ErrorAction Stop' : 'touch forbidden', true)
    if (readOnly.exitCode === 0)
      throw new Error('Installed sandbox allowed a read-only write')
    await absent(join(workspace, 'forbidden'))
    let hits = 0
    const server = createServer((_request, response) => {
      hits++
      response.end('approved')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Installed sandbox network fixture did not start')
      const curl = `${powershell ? 'curl.exe' : 'curl'} --silent --fail --max-time 3 http://127.0.0.1:${address.port}`
      if (powershell) {
        const local = await execute(curl)
        if (local.exitCode !== 0 || local.output !== 'approved' || Number(hits) !== 1)
          throw new Error('Installed sandbox could not reach a host loopback service')
      }
      const previousHits = hits
      const proxied = `${curl} --noproxy lexora-proxy-required.invalid`
      const denied = await execute(proxied)
      if (denied.exitCode === 0 || hits !== previousHits)
        throw new Error('Installed sandbox bypassed network approval')
      const allowed = await execute(proxied, false, true)
      if (allowed.exitCode !== 0 || allowed.output !== 'approved' || Number(hits) !== previousHits + 1)
        throw new Error('Installed sandbox network approval did not reach its destination')
    }
    finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    try {
      await execute(powershell ? 'Start-Sleep -Seconds 2; Set-Content -LiteralPath late -Value changed' : '(sleep 2; touch late) & wait', false, false, 0.05)
      throw new Error('Installed sandbox ignored its timeout')
    }
    catch (error) {
      if (!(error instanceof ShellSandboxError) || error.code !== 'SANDBOX_TIMEOUT')
        throw error
    }
    const cancellation = new AbortController()
    try {
      await execute(powershell ? '[Console]::Out.Write("CANCEL_READY"); Start-Sleep -Seconds 2; Set-Content -LiteralPath cancelled -Value changed' : 'printf CANCEL_READY; (sleep 2; touch cancelled) & wait', false, false, 10, cancellation)
      throw new Error('Installed sandbox ignored its cancellation')
    }
    catch (error) {
      if (error !== cancellation.signal.reason && (!(error instanceof ShellSandboxError) || error.code !== 'SANDBOX_CANCELLED'))
        throw error
    }
    await setTimeout(2_100)
    await absent(join(workspace, 'late'))
    await absent(join(workspace, 'cancelled'))
    if (scale) {
      for (let iteration = 0; iteration < 3; iteration++) {
        const start = performance.now()
        const result = await execute(powershell ? '[Console]::Out.Write(\'SCALE_OK\')' : 'printf SCALE_OK')
        const elapsed = performance.now() - start
        if (result.exitCode !== 0 || result.output !== 'SCALE_OK' || elapsed > 5_000)
          throw new Error(`Installed sandbox exceeded its repeated command budget: ${elapsed} ms; ${JSON.stringify(result)}`)
        measurements.push(elapsed)
      }
    }
    return { preparationMs, firstCommandMs, repeatedRpcMs: measurements }
  }
  catch (error) {
    throw new Error(`Installed sandbox verification failed at command ${commandNumber}: ${error instanceof Error ? error.message : String(error)}; ${JSON.stringify(events)}`, { cause: error })
  }
  finally {
    observation.dispose()
    hostObservation.dispose()
    if (originalPath === undefined)
      delete process.env.PATH
    else process.env.PATH = originalPath
    await client.dispose()
    await disposeHost.dispose()
    host.close(new Error('Installation verification completed'))
    runtime.close(new Error('Installation verification completed'))
    channel.port1.close()
    channel.port2.close()
    await rm(directory, { recursive: true, force: true })
  }
}
