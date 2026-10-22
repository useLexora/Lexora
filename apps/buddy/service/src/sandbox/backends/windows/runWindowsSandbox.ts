import type { Socket } from 'node:net'
import type { SandboxBackendInput } from '../../../../../shared/permissions/shellSandbox'
import type { SHELL_SANDBOX_BACKEND } from '../../../../../shared/platform/identifiers'
import type { SandboxExecutionOptions } from '../../sandboxExecutionLifecycle'
import { randomBytes } from 'node:crypto'
import process from 'node:process'
import { createHttpProxyServer } from '@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js'
import { resolveParentProxy } from '@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js'
import { createResolvedAddressGuard } from '@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js'
import { createWindowsSandboxEnvironment } from '../../../../../platform/process/sandboxEnvironment'
import { buildShellInvocation } from '../../../../../platform/process/shellPrograms'
import { runWindowsSandboxProcess } from '../../../../../platform/process/windowsSandboxProcess'
import { ShellSandboxError } from '../../../../../shared/permissions/shellSandbox'
import { createWindowsSandboxPolicy } from './createPolicy'

export async function runWindowsSandbox(input: SandboxBackendInput<typeof SHELL_SANDBOX_BACKEND.Windows>, options: SandboxExecutionOptions): Promise<number | null> {
  const environment = options.environment ?? process.env
  const httpProxy = environment.HTTP_PROXY ?? environment.http_proxy ?? ''
  const httpsProxy = environment.HTTPS_PROXY ?? environment.https_proxy ?? httpProxy
  const program = input.shell ?? { dialect: 'powershell' as const, executable: input.backend.shell }
  buildShellInvocation(program, input.command)
  const { grants, path } = await createWindowsSandboxPolicy(input, options.signal)
  const token = randomBytes(32).toString('hex')
  const guard = createResolvedAddressGuard({ deniedResolvedAddresses: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7'] })
  const connections = new Set<Socket>()
  const proxy = createHttpProxyServer({
    filter: (port, host) => options.signal.aborted ? false : options.approveNetwork({ host, port }),
    lookupFor: port => guard.lookupFor(port),
    proxyAuthToken: token,
    parentProxy: resolveParentProxy({ http: httpProxy, https: httpsProxy, noProxy: environment.NO_PROXY ?? environment.no_proxy ?? '' }),
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
      shell: program.executable,
      ...(input.shell ? { dialect: program.dialect } : {}),
      privateRoot: input.privateRoot,
      grants,
      denyReadScope: input.backend.protectionScope,
      proxyPort: address.port,
      environment: createWindowsSandboxEnvironment(environment, {
        ...input.backend,
        shell: program.executable,
        dialect: program.dialect,
        privateRoot: input.privateRoot,
        path,
        proxyUrl: `http://srt:${token}@127.0.0.1:${address.port}`,
      }),
    }, { ...options, executionId: input.executionId, dispatchId: input.dispatchId, receiptDirectory: input.receiptDirectory })
  }
  finally {
    for (const socket of connections)
      socket.destroy()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
  }
}
