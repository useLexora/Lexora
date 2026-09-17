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

export async function verifySandboxInstallation(options: SandboxHostOptions): Promise<void> {
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
  const powershell = currentPlatform.shell === 'powershell'
  const execute = async (command: string, readOnly = false, approve = false, timeout = 10) => {
    const output: Buffer[] = []
    const result = await client.exec({ command, cwd: workspace, roots: [workspace], workspaceRoots: [workspace], resourceReadRoots: [], additionalDirectories: [], readOnly, timeout }, {
      onData: data => output.push(data),
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
    await writeFile(join(workspace, '.env'), 'synthetic-secret')
    const write = await execute(powershell ? 'Set-Content -LiteralPath result -Value ready -NoNewline' : 'printf ready > result')
    if (write.exitCode !== 0 || await readFile(join(workspace, 'result'), 'utf8') !== 'ready')
      throw new Error('Installed sandbox could not write its authorized workspace')
    const secret = await execute(powershell ? 'Get-Content -LiteralPath .env -ErrorAction Stop' : 'cat .env')
    if (secret.exitCode === 0 || secret.output.includes('synthetic-secret'))
      throw new Error('Installed sandbox exposed a protected file')
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
      const denied = await execute(curl)
      if (denied.exitCode === 0 || hits !== 0)
        throw new Error('Installed sandbox bypassed network approval')
      const allowed = await execute(curl, false, true)
      if (allowed.exitCode !== 0 || allowed.output !== 'approved' || Number(hits) !== 1)
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
    await setTimeout(2_100)
    await absent(join(workspace, 'late'))
  }
  finally {
    client.dispose()
    disposeHost()
    host.close(new Error('Installation verification completed'))
    runtime.close(new Error('Installation verification completed'))
    channel.port1.close()
    channel.port2.close()
    await rm(directory, { recursive: true, force: true })
  }
}
