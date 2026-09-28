import type { SandboxNetworkTarget } from '../../../shared/permissions/shellSandbox'
import type { BuddyCapability } from '../agent/extensions/BuddyCapability'
import type { BuddyExtensionRunContext } from '../agent/extensions/BuddyExtensionRunContext'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { ToolAuthorizationService } from '../permissions/ToolAuthorizationService'
import type { SandboxDirectoryPermissions } from './SandboxDirectoryPermissions'
import type { ShellExecution } from './shellExecution'
import type { ShellSandboxClient } from './ShellSandboxClient'
import { Buffer } from 'node:buffer'
import { createBashToolDefinition, createPowerShellToolDefinition, defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { ShellSandboxError } from '../../../shared/permissions/shellSandbox'
import { ApprovalCancelledError, ApprovalExpiredError } from '../approvals/ApprovalService'

export const SHELL_SANDBOX_EXTENSION = 'lexora-shell-sandbox'

export function createShellCapability(options: {
  cwd: string
  execution: ShellExecution
  getGrants: () => readonly DirectoryGrant[]
  resourceReadRoots?: readonly string[]
  getRunContext: () => BuddyExtensionRunContext | null
  authorization: ToolAuthorizationService
  sandbox: Pick<ShellSandboxClient, 'exec'> | undefined
  directoryPermissions: SandboxDirectoryPermissions
}): BuddyCapability {
  const shellName = options.execution.dialect
  const createShell = shellName === 'powershell' ? createPowerShellToolDefinition : createBashToolDefinition
  const directoryParameters = Type.Object({
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    access: Type.Union([Type.Literal('read'), Type.Literal('write')]),
    reason: Type.String({ minLength: 1, maxLength: 512 }),
  }, { additionalProperties: false })
  return {
    workspaceMutationTools: ['lexora_host_shell'],
    async classify(event) {
      if (event.toolName === shellName)
        return { access: 'execute', shellBoundary: 'sandbox' }
      if (event.toolName === 'lexora_host_shell')
        return { access: 'execute', forceAsk: true }
      if (event.toolName !== 'lexora_authorize_directory')
        return null
      return { shellBoundary: 'sandbox' }
    },
    extension: {
      name: SHELL_SANDBOX_EXTENSION,
      factory(pi) {
        const native = createShell(options.cwd, { exposeSessionEnvironment: false })
        pi.registerTool({
          ...native,
          description: `${native.description}\nRuns in an OS sandbox. Only authorized directories and installed toolchains are readable; credentials and host IPC are hidden. Writes are limited by the conversation profile. Network destinations pause for explicit approval. No automatic host fallback.`,
          promptGuidelines: [
            `Use ${shellName} for ordinary commands, pipelines, scripts and project builds inside the sandbox. Read failures outside granted directories require a directory authorization; do not disguise paths or use another interpreter to evade a denial.`,
            'The sandbox has a private temporary HOME and TMPDIR. Host credentials, desktop sockets and repository Git metadata writes are not available. Use lexora_authorize_directory with the least access needed for additional directories; its permissions expire with the current run and do not apply to other tools. Use lexora_host_shell only when the requested task genuinely needs host access. Never use it to retry a request the user denied.',
          ],
          async execute(toolCallId, parameters, signal, onUpdate, context) {
            const run = options.getRunContext()
            if (!run || !options.sandbox)
              throw new ShellSandboxError('SANDBOX_UNAVAILABLE')
            const lifetime = new AbortController()
            const executionSignal = AbortSignal.any([lifetime.signal, run.signal, ...signal ? [signal] : []])
            const tool = createShell(options.cwd, {
              exposeSessionEnvironment: false,
              operations: {
                exec: async (command, cwd, execOptions) => {
                  const failures: (SandboxNetworkTarget & { code: string })[] = []
                  let omitted = 0
                  const recordFailure = (target: SandboxNetworkTarget, code: string) => {
                    if (failures.length < 16)
                      failures.push({ ...target, code })
                    else
                      omitted++
                  }
                  try {
                    return await options.sandbox!.exec({
                      command,
                      cwd,
                      readOnly: options.execution.readOnly,
                      roots: [...new Set(options.getGrants().map(grant => grant.canonicalRoot))],
                      workspaceRoots: options.getGrants().filter(grant => grant.kind === 'workspace').map(grant => grant.canonicalRoot),
                      additionalDirectories: [...options.directoryPermissions.get(run)],
                      resourceReadRoots: [...(options.resourceReadRoots ?? [])],
                      timeout: execOptions.timeout,
                    }, { ...execOptions, signal: executionSignal }, async (target) => {
                      if (executionSignal.aborted)
                        return false
                      try {
                        const reason = await options.authorization.authorize({
                          input: parameters,
                          toolCallId,
                          toolName: shellName,
                        }, run, { access: 'network', requireApproval: true }, { network: target, signal: executionSignal })
                        if (reason !== null)
                          recordFailure(target, reason)
                        return reason === null
                      }
                      catch (error) {
                        recordFailure(target, error instanceof ApprovalCancelledError || error instanceof ApprovalExpiredError ? error.code : 'NETWORK_APPROVAL_FAILED')
                        throw error
                      }
                    })
                  }
                  finally {
                    if (failures.length && !executionSignal.aborted) {
                      execOptions.onData(Buffer.from(`\n[Network authorization]\n${JSON.stringify({ requests: failures, omitted })}\nThese requests were not authorized. Do not retry a declined or cancelled request through another command or tool. An authorization error does not mean the user refused. These facts do not diagnose other command failures or override its exit status.\n`))
                    }
                  }
                },
              },
            })
            try {
              return await tool.execute(toolCallId, parameters, executionSignal, onUpdate, context)
            }
            finally { lifetime.abort() }
          },
        })
        if (!options.execution.readOnly) {
          pi.registerTool({
            ...native,
            name: 'lexora_host_shell',
            label: 'Host shell',
            description: 'Run a command OUTSIDE the sandbox with the desktop service user permissions, including host files, credentials, network and desktop IPC. Requires user authorization; reusable grants expire with the current run. Use only when isolation prevents an operation required by the user, never to evade a declined request. Supply command and optional timeout in seconds.',
            promptSnippet: 'Run an authorized host command outside the sandbox',
            promptGuidelines: [],
          })
        }
        pi.registerTool(defineTool({
          name: 'lexora_authorize_directory',
          label: 'Authorize a directory',
          description: 'Request access to one existing directory for isolated shell commands in the CURRENT RUN only. Choose read for inspection, write only when the task requires creating, editing or deleting files. Explain why access is needed. Write includes read. Permissions expire at run completion, cancellation or restart; they do not grant other tools access or change saved conversation/Space permissions. Credential restrictions remain. Read-only mode cannot grant write access.',
          parameters: directoryParameters,
          async execute() {
            const directories = options.directoryPermissions.get(options.getRunContext()).map(({ path, access }) => ({ path, access }))
            const result = { authorizedDirectories: directories, scope: 'run', appliesTo: 'sandbox-shell' }
            return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
          },
        }))
      },
    },
  }
}
