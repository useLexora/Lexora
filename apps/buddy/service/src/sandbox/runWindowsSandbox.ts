import type { Socket } from 'node:net'
import type { SandboxBackendInput } from '../../../shared/permissions/shellSandbox'
import type { SandboxExecutionOptions } from './sandboxExecutionLifecycle'
import { randomBytes } from 'node:crypto'
import { createHttpProxyServer } from '@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js'
import { resolveParentProxy } from '@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js'
import { createResolvedAddressGuard } from '@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js'
import { createWindowsSandboxEnvironment } from '../../../platform/process/sandboxEnvironment'
import { runWindowsSandboxProcess } from '../../../platform/process/windowsSandboxProcess'
import { ShellSandboxError } from '../../../shared/permissions/shellSandbox'
import { createWindowsSandboxPolicy } from './windowsSandboxPolicy'

export async function runWindowsSandbox(input: SandboxBackendInput<'windows-lpac'>, options: SandboxExecutionOptions): Promise<number | null> {
  const { grants, path } = await createWindowsSandboxPolicy(input, options.signal)
  const token = randomBytes(32).toString('hex')
  const guard = createResolvedAddressGuard({ deniedResolvedAddresses: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7'] })
  const connections = new Set<Socket>()
  const proxy = createHttpProxyServer({
    filter: (port, host) => options.signal.aborted ? false : options.approveNetwork({ host, port }),
    lookupFor: port => guard.lookupFor(port),
    proxyAuthToken: token,
    parentProxy: resolveParentProxy(),
  })
  proxy.on('connection', (socket) => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject)
      proxy.listen(0, '127.0.0.1', resolve)
    })
    options.signal.throwIfAborted()
    const address = proxy.address()
    if (!address || typeof address === 'string')
      throw new ShellSandboxError('SANDBOX_UNAVAILABLE')
    return await runWindowsSandboxProcess(input.backend.executable, {
      command: input.command,
      cwd: input.cwd,
      shell: input.backend.shell,
      privateRoot: input.privateRoot,
      grants,
      proxyPort: address.port,
      environment: createWindowsSandboxEnvironment({
        ...input.backend,
        privateRoot: input.privateRoot,
        path,
        proxyUrl: `http://srt:${token}@127.0.0.1:${address.port}`,
      }),
    }, options)
  }
  finally {
    for (const socket of connections)
      socket.destroy()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
  }
}
