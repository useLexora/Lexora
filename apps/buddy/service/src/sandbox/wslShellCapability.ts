import type { BuddyCapability } from '../agent/extensions/BuddyCapability'
import type { BuddyExtensionRunContext } from '../agent/extensions/BuddyExtensionRunContext'
import type { RunWslShell } from '../wsl/WslHostPool'
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent'
import { parseWslPath } from '../../../shared/files/wslPath'
import { sharedWslHosts } from '../wsl/sharedWslHosts'

export const WSL_SHELL_EXTENSION = 'lexora-wsl-shell'
export const WSL_SHELL_TOOL_NAME = 'lexora_wsl_shell'

const MAX_TIMEOUT_MS = 2_147_483_647

// Runs a bash command inside the WSL distribution of the working directory, through the resident helper. It is a host-level
// tool like lexora_host_shell: a Linux process is outside the Windows sandbox, so it is denied in read-only mode, always asks
// unless the profile is full access, and holds the workspace as a host mutation while it runs. The command is passed as one
// argument all the way to `bash -lc`, so nothing is quoted for PowerShell and no temporary script is needed.
// It is offered only when the working directory is in WSL.
export function createWslShellCapability(options: {
  cwd: string
  getRunContext: () => BuddyExtensionRunContext | null
  assertExecutionAllowed?: (input: { run: BuddyExtensionRunContext }) => void | Promise<void>
  shell?: RunWslShell
}): BuddyCapability {
  const workspace = parseWslPath(options.cwd)
  const shell = options.shell ?? sharedWslHosts.shell
  return {
    disclosure: workspace
      ? [{ source: { kind: 'builtin', id: 'wsl-shell', title: 'WSL shell' }, exposure: 'direct', keywords: 'wsl linux bash shell command 命令 终端', tools: [{ name: WSL_SHELL_TOOL_NAME }] }]
      : [],
    workspaceMutationTools: [WSL_SHELL_TOOL_NAME],
    // The command and the distribution are what the user approves; a repeat of the same command may reuse the approval.
    classify(event) {
      if (event.toolName !== WSL_SHELL_TOOL_NAME || !workspace)
        return null
      const identity = [WSL_SHELL_TOOL_NAME, workspace.distribution]
      return {
        access: 'execute',
        shellDialect: 'bash',
        approval: {
          summary: `Run a bash command in WSL (${workspace.distribution}), outside the Windows sandbox`,
          reuse: { operation: [...identity, event.input], source: identity },
        },
      }
    },
    // The helper kills the command's process group when the service goes away, so there is no process left to recover.
    mutationEffect: event => event.toolName === WSL_SHELL_TOOL_NAME ? { kind: 'host', ownedProcess: false } : null,
    extension: {
      name: WSL_SHELL_EXTENSION,
      factory(pi) {
        if (!workspace)
          return
        const native = createBashToolDefinition(options.cwd, {
          exposeSessionEnvironment: false,
          operations: {
            async exec(command, cwd, { onData, signal, timeout }) {
              const location = parseWslPath(cwd)
              if (!location)
                throw new Error(`${WSL_SHELL_TOOL_NAME} runs only in a directory inside WSL`)
              if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > MAX_TIMEOUT_MS))
                throw new Error('Invalid timeout: must be a finite number of seconds')
              return shell({ distribution: location.distribution, cwd: location.linuxPath, command, signal, timeout, onData })
            },
          },
        })
        pi.registerTool({
          ...native,
          name: WSL_SHELL_TOOL_NAME,
          label: 'WSL shell',
          description: `Run a bash command inside the WSL distribution ${workspace.distribution}, in the current working directory, with Linux paths. The command runs as the distribution's own user with the PATH of its login shell (nvm, cargo and similar tools are found), outside the Windows sandbox. It is noninteractive and has no terminal. ${native.description}`,
          promptSnippet: 'Run a bash command inside WSL',
          promptGuidelines: [
            `Use ${WSL_SHELL_TOOL_NAME} for commands in the WSL working directory: write the command for bash with Linux paths. Do not run wsl.exe through another shell, quote for PowerShell, or write a temporary script file.`,
            'For searching and for reading, writing and editing files use grep, find, ls, read, write and edit; they are faster and reviewable. Use the shell for builds, tests, git and other programs.',
            'These commands run outside the Windows sandbox with the full permissions of the Linux user, so each one needs approval unless full access is on. Never use it to retry a request the user declined.',
          ],
          async execute(toolCallId, parameters, signal, onUpdate, context) {
            const run = options.getRunContext()
            if (!run)
              throw new Error('WSL_SHELL_UNAVAILABLE')
            await options.assertExecutionAllowed?.({ run })
            return native.execute(toolCallId, parameters, AbortSignal.any([run.signal, ...signal ? [signal] : []]), onUpdate, context)
          },
        })
      },
    },
  }
}
