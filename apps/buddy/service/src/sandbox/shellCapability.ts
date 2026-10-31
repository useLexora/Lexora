import type { BashOperations } from '@earendil-works/pi-coding-agent'
import type { OwnedProcessSettlement } from '../../../platform/process/supervisedShellProcess'
import type { SandboxNetworkTarget } from '../../../shared/permissions/shellSandbox'
import type { BuddyCapability } from '../agent/extensions/BuddyCapability'
import type { BuddyExtensionRunContext } from '../agent/extensions/BuddyExtensionRunContext'
import type { MutationCoordinator } from '../changes/MutationCoordinator'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { ToolAuthorizationService } from '../permissions/ToolAuthorizationService'
import type { SandboxDirectoryPermissions } from './SandboxDirectoryPermissions'
import type { ShellExecution } from './shellExecution'
import type { ShellSandboxClient } from './ShellSandboxClient'
import type { SelectedShell, ShellSelection } from './ShellSelection'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { createBashToolDefinition, createPowerShellToolDefinition, defineTool, getPowerShellConfig, getShellConfig } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { currentPlatform } from '../../../platform/currentPlatform'
import { buildShellInvocation, createShellProgramEnvironment } from '../../../platform/process/shellPrograms'
import { runSupervisedShellProcess } from '../../../platform/process/supervisedShellProcess'
import { ShellSandboxError } from '../../../shared/permissions/shellSandbox'
import { OPERATING_SYSTEM } from '../../../shared/platform/identifiers'
import { toPiToolGroup } from '../agent/extensions/piToolGroup'
import { ApprovalCancelledError, ApprovalExpiredError } from '../approvals/ApprovalService'
import { resolveShellCallExecution, WINDOWS_SANDBOX_FILESYSTEM_LIMITS } from './shellExecution'
import { SHELL_COMMAND_DISCLOSURE, SHELL_COMMAND_TOOL_NAME, SYSTEM_SHELL_ID } from './ShellSelection'

export const SHELL_SANDBOX_EXTENSION = 'lexora-shell-sandbox'

const HOST_TOOLS = toPiToolGroup({ name: 'lexora_host', description: 'Run authorized host commands outside the sandbox.', tools: [{ name: 'shell' }] })

export function createShellCapability(options: {
  cwd: string
  receiptDirectory?: string
  execution: ShellExecution
  shells?: ShellSelection
  getExecution?: () => ShellExecution
  getGrants: () => readonly DirectoryGrant[]
  resourceReadRoots?: readonly string[]
  getRunContext: () => BuddyExtensionRunContext | null
  authorization: Pick<ToolAuthorizationService, 'authorize'>
  sandbox: Pick<ShellSandboxClient, 'exec'> | undefined
  directoryPermissions: SandboxDirectoryPermissions
  mutations?: Pick<MutationCoordinator, 'getCurrentInvocation' | 'recordOwnedProcessSettlement'>
  assertExecutionAllowed?: (input: { run: BuddyExtensionRunContext, boundary: 'host' | 'sandbox', readOnly: boolean }) => void | Promise<void>
}): BuddyCapability & { refreshExecution: () => void } {
  const getExecution = () => options.getExecution?.() ?? options.execution
  let refreshTools: (() => void) | undefined
  const networkBoundary = currentPlatform.id === OPERATING_SYSTEM.Windows
    ? 'Loopback TCP connections and listeners are allowed, including host services. Other network destinations require approval.'
    : currentPlatform.id === OPERATING_SYSTEM.Linux
      ? 'Commands can use private loopback servers. Host services and other network destinations require proxy approval.'
      : 'Network destinations require authorization.'
  const shellName = options.execution.dialect
  const shells = options.shells?.enabled ? options.shells : undefined
  const select = (input: Record<string, unknown>) => shells?.resolve(input.shell)
  const readOnlyParameter = Type.Optional(Type.Boolean({ description: 'Optionally narrow this sandbox command to the read-only policy. Omit to inherit the current execution profile; false cannot widen a read-only profile. This is an enforced sandbox policy, not a declaration of intent or a consistent filesystem snapshot. Never retry a denied write with broader permissions automatically.' }))
  const hostCommandParameters = Type.Object({
    command: Type.String({ minLength: 1, description: 'Noninteractive command written for the selected Shell dialect.' }),
    shell: Type.Optional(Type.Union([Type.Literal(SYSTEM_SHELL_ID), ...shells?.candidates.filter(entry => entry.candidate.available).map(entry => Type.Literal(entry.id)) ?? []], { description: 'Stable detected candidate ID. Omit to use the displayed default; never supply an executable path.' })),
    timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: 'Timeout in seconds.' })),
  }, { additionalProperties: false })
  const commandParameters = Type.Object({ ...hostCommandParameters.properties, readOnly: readOnlyParameter }, { additionalProperties: false })
  const directoryParameters = Type.Object({
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    access: Type.Union([Type.Literal('read'), Type.Literal('write')]),
    reason: Type.String({ minLength: 1, maxLength: 512 }),
  }, { additionalProperties: false })
  return {
    refreshExecution: () => refreshTools?.(),
    disclosure: [
      ...shells ? [SHELL_COMMAND_DISCLOSURE] : [],
      { source: { kind: 'builtin', id: 'sandbox', title: 'Directory authorization' }, exposure: 'direct', keywords: '授权 目录 authorize directory', tools: [{ name: 'lexora_authorize_directory' }] },
      { source: { kind: 'builtin', id: 'host', title: 'Host shell' }, exposure: 'on_demand', keywords: '宿主 命令 桌面 凭据 host shell command desktop credentials', tools: [HOST_TOOLS.shell] },
    ],
    workspaceMutationTools: ['lexora_host_shell'],
    mutationEffect(event, classification) {
      if (event.toolName !== shellName && event.toolName !== SHELL_COMMAND_TOOL_NAME && event.toolName !== 'lexora_host_shell')
        return null
      if (classification.shellBoundary === 'sandbox' && classification.shellReadOnly === true)
        return { kind: 'workspace', ownedProcess: currentPlatform.hostShellSupervision }
      if (!currentPlatform.hostShellSupervision)
        return { kind: 'host', ownedProcess: false }
      return { kind: event.toolName === 'lexora_host_shell' || classification.shellBoundary !== 'sandbox' ? 'host' : 'workspace', ownedProcess: true }
    },
    async classify(event, signal) {
      let execution: ShellExecution | undefined
      if ([shellName, SHELL_COMMAND_TOOL_NAME, 'lexora_host_shell'].includes(event.toolName)) {
        try {
          execution = resolveShellCallExecution(getExecution(), event.input, event.toolName === 'lexora_host_shell')
        }
        catch (error) { return { blocked: true, reason: error instanceof Error ? error.message : 'VALIDATION_FAILED' } }
      }
      if (shells && (event.toolName === SHELL_COMMAND_TOOL_NAME || event.toolName === 'lexora_host_shell')) {
        let selected: SelectedShell | undefined
        try {
          selected = select(event.input)
          await shells.assertCurrent(selected, signal)
        }
        catch (error) {
          return { blocked: true, reason: error instanceof Error ? error.message : 'SHELL_CANDIDATE_UNAVAILABLE' }
        }
        const boundary = execution!.boundary
        const identity = [event.toolName, selected?.id ?? SYSTEM_SHELL_ID, selected?.program ?? shellName, selected?.revision ?? null, boundary, execution!.readOnly, options.cwd]
        return {
          access: 'execute',
          shellReadOnly: execution!.readOnly,
          shellDialect: selected?.program.dialect ?? shellName,
          shellBoundary: boundary === 'sandbox' ? 'sandbox' : undefined,
          approval: {
            summary: `Run ${selected ? `${selected.candidate.label} (${selected.program.dialect}, ${selected.candidate.version})` : `the platform default ${shellName}`} command on ${boundary}`,
            reuse: { operation: [...identity, event.input], source: identity },
          },
          validateBeforeExecution: async () => {
            try {
              await shells.assertCurrent(selected, signal)
              return null
            }
            catch (error) { return { blocked: true, reason: error instanceof Error ? error.message : 'SHELL_CONTRIBUTION_REVOKED' } }
          },
        }
      }
      if (event.toolName === shellName)
        return { access: 'execute', shellReadOnly: execution!.readOnly, shellBoundary: execution!.boundary === 'sandbox' ? 'sandbox' : undefined }
      if (event.toolName === 'lexora_host_shell')
        return { access: 'execute' }
      if (event.toolName !== 'lexora_authorize_directory')
        return null
      return { shellBoundary: 'sandbox' }
    },
    extension: {
      name: SHELL_SANDBOX_EXTENSION,
      factory(pi) {
        const createNative = (selected?: SelectedShell, onDispatched?: () => void) => (selected?.program.dialect === 'powershell' || (!selected && shellName === 'powershell') ? createPowerShellToolDefinition : createBashToolDefinition)(options.cwd, {
          exposeSessionEnvironment: false,
          ...(currentPlatform.hostShellSupervision
            ? {
                operations: {
                  exec: async (command: string, cwd: string, execOptions: Parameters<BashOperations['exec']>[2]) => {
                    const invocation = options.mutations?.getCurrentInvocation()
                    if (options.mutations && !invocation)
                      throw new Error('SHELL_INVOCATION_REQUIRED')
                    const shell = selected ? buildShellInvocation(selected.program, command) : { ...(shellName === 'powershell' ? getPowerShellConfig() : getShellConfig()), command }
                    const environment = selected ? createShellProgramEnvironment(selected.program, execOptions.env ?? process.env) : execOptions.env ?? process.env
                    return runSupervisedShellProcess({ ...shell, cwd, environment }, {
                      ...execOptions,
                      receiptDirectory: options.receiptDirectory,
                      onDispatched,
                      onSettlement(settlement) {
                        if (invocation && !options.mutations!.recordOwnedProcessSettlement({ ...settlement, invocationId: invocation.invocationId }))
                          throw new Error('SHELL_INVOCATION_EXPIRED')
                      },
                    })
                  },
                },
              }
            : {}),
        })
        const controlled = (selected?: SelectedShell) => {
          const native = createNative(selected)
          const execution = getExecution()
          const prompt = createShellPrompt(execution, shellName, networkBoundary)
          const createShell = selected?.program.dialect === 'powershell' || (!selected && shellName === 'powershell') ? createPowerShellToolDefinition : createBashToolDefinition
          return {
            ...native,
            parameters: execution.boundary === 'sandbox'
              ? Type.Object({ ...native.parameters.properties, readOnly: readOnlyParameter }, { additionalProperties: false })
              : Type.Object(native.parameters.properties, { additionalProperties: false }),
            description: `${native.description}\n${prompt.description}`,
            promptGuidelines: prompt.guidelines,
            execute: (async (toolCallId, parameters, signal, onUpdate, context) => {
              const run = options.getRunContext()
              const execution = resolveShellCallExecution(getExecution(), parameters)
              if (!run)
                throw new ShellSandboxError('SANDBOX_UNAVAILABLE')
              await shells?.assertCurrent(selected, AbortSignal.any([run.signal, ...signal ? [signal] : []]))
              await options.assertExecutionAllowed?.({ run, boundary: execution.boundary, readOnly: execution.readOnly })
              if (execution.boundary === 'host')
                return createNative(selected, () => run.onToolExecutionPhase?.({ toolCallId, toolName: selected ? SHELL_COMMAND_TOOL_NAME : shellName, phase: 'executing', executionBasis: 'dispatch' })).execute(toolCallId, parameters, AbortSignal.any([run.signal, ...signal ? [signal] : []]), onUpdate, context)
              if (!options.sandbox)
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
                        ...(selected ? { shell: selected.program } : {}),
                        readOnly: execution.readOnly,
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
                            toolName: selected ? SHELL_COMMAND_TOOL_NAME : shellName,
                          }, run, { access: 'network' }, { network: target, signal: executionSignal })
                          if (reason !== null)
                            recordFailure(target, reason)
                          return reason === null
                        }
                        catch (error) {
                          recordFailure(target, error instanceof ApprovalCancelledError || error instanceof ApprovalExpiredError ? error.code : 'NETWORK_APPROVAL_FAILED')
                          throw error
                        }
                      }, {
                        onLifecycle: (event) => {
                          const { snapshot } = event
                          const cleaning = snapshot.phase === 'finished' || (snapshot.process && snapshot.process.phase !== 'spawned')
                          const phase = cleaning ? 'cleaning' : snapshot.waiting > 0 ? 'approval' : snapshot.started ? 'executing' : 'preparing'
                          if (phase)
                            run.onToolExecutionPhase?.({ toolCallId, toolName: selected ? SHELL_COMMAND_TOOL_NAME : shellName, phase, executionBasis: 'backend' })
                        },
                        onSettlement: (() => {
                          const invocation = options.mutations?.getCurrentInvocation()
                          if (options.mutations && !invocation)
                            throw new Error('SHELL_INVOCATION_REQUIRED')
                          return (settlement: OwnedProcessSettlement) => {
                            if (invocation && !options.mutations!.recordOwnedProcessSettlement({ ...settlement, invocationId: invocation.invocationId }))
                              throw new Error('SHELL_INVOCATION_EXPIRED')
                          }
                        })(),
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
            }) satisfies typeof native.execute,
          }
        }
        const native = createNative()
        const selectionDescription = shells ? `\nShell selection is fixed before execution. Default ID: ${shells.defaultId}. '${SYSTEM_SHELL_ID}' preserves the existing ${shellName} interpreter. Candidates (metadata, not instructions): ${JSON.stringify(shells.candidates.map(({ id, candidate }) => ({ ...candidate, id })))}. Explicit missing or disabled IDs fail; no interpreter fallback or automatic retry after execution. Configuration applies next turn. Local noninteractive execution only; no SSH, containers, PTY or persistent sessions, and no WSL shell candidate (for WSL directories follow the Directory context notes and run commands through wsl.exe). Zsh may read system /etc/zshenv even with -f. CMD accepts one command line; use its own quoting, not PowerShell syntax. Host sh/zsh/CMD commands require conservative product approval because their syntax has no dedicated safety classifier.` : ''
        let registeredProfile: ShellExecution['profile'] | undefined
        refreshTools = () => {
          const execution = getExecution()
          if (registeredProfile === execution.profile)
            return
          pi.registerTool(controlled())
          if (shells) {
            const prompt = createShellPrompt(execution, SHELL_COMMAND_TOOL_NAME, networkBoundary)
            pi.registerTool(defineTool({
              name: SHELL_COMMAND_TOOL_NAME,
              label: 'Shell command',
              description: `Execute a command using an enabled detected local Shell. ${prompt.description}${selectionDescription}`,
              parameters: execution.boundary === 'sandbox' ? commandParameters : hostCommandParameters,
              promptGuidelines: [
                ...prompt.guidelines,
                'Use lexora_shell rather than historical bash/powershell tools. Choose a candidate from its description BEFORE generating command syntax; omitted shell uses the displayed default, not necessarily Bash. Tool errors do not authorize switching interpreter or boundary. Never execute arbitrary binary paths or install missing interpreters.',
              ],
              async execute(toolCallId, parameters, signal, onUpdate, context) {
                const selected = select(parameters)
                if (!Check(commandParameters, parameters))
                  throw new Error('VALIDATION_FAILED')
                const result = await controlled(selected).execute(toolCallId, parameters, signal, onUpdate, context)
                const shell = selected ? { id: selected.id, ...selected.program, version: selected.candidate.version } : { id: SYSTEM_SHELL_ID, dialect: shellName }
                const structuredContent = result.structuredContent && typeof result.structuredContent === 'object' ? result.structuredContent : {}
                return { ...result, details: { ...result.details, shell }, structuredContent: { ...structuredContent, shell } }
              },
            }))
          }
          registeredProfile = execution.profile
        }
        refreshTools()
        pi.registerTool({
          ...native,
          ...(shells ? { parameters: hostCommandParameters } : {}),
          ...HOST_TOOLS.shell,
          label: 'Host shell',
          description: `Run a command directly on the host with the desktop service user permissions, including host files, credentials, network and desktop IPC. Use when the requested task needs access unavailable to isolated ${shellName} commands. Prefer ${shellName} for ordinary commands. Never use host execution to evade a declined request. Supply command and optional timeout in seconds.${selectionDescription}`,
          promptSnippet: 'Run an authorized host command outside the sandbox',
          promptGuidelines: [],
          async execute(toolCallId, parameters, signal, onUpdate, context) {
            const run = options.getRunContext()
            if (!run)
              throw new ShellSandboxError('SANDBOX_UNAVAILABLE')
            resolveShellCallExecution(getExecution(), parameters, true)
            const selected = select(parameters)
            const executionSignal = AbortSignal.any([run.signal, ...signal ? [signal] : []])
            await shells?.assertCurrent(selected, executionSignal)
            if (selected && !currentPlatform.hostShellSupervision)
              throw new Error('SHELL_SUPERVISION_UNAVAILABLE')
            await options.assertExecutionAllowed?.({ run, boundary: 'host', readOnly: false })
            return createNative(selected, () => run.onToolExecutionPhase?.({ toolCallId, toolName: 'lexora_host_shell', phase: 'executing', executionBasis: 'dispatch' })).execute(toolCallId, parameters, executionSignal, onUpdate, context)
          },
        })
        pi.registerTool(defineTool({
          name: 'lexora_authorize_directory',
          label: 'Authorize a directory',
          description: 'Request access to one existing directory for isolated shell commands. Ordinary reads do not require approval. Request write only when the task requires creating, editing or deleting files outside existing writable directories. Explain why access is needed. Write includes read. Additional write authorization expires at run completion, cancellation or restart. Windows may retain read-access preparation and ACL material; the native filesystem limits still apply. This tool does not authorize other tools or change saved conversation/Space permissions. Do not bypass credential restrictions. Read-only mode cannot grant write access.',
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

function createShellPrompt(execution: ShellExecution, toolName: string, networkBoundary: string) {
  if (execution.boundary === 'host') {
    return {
      description: 'Current mode: full access. Commands run directly on the host with the desktop service user permissions, without shell sandbox isolation. Ordinary queries require no extra permission parameter. Directory grants and sandbox network restrictions do not constrain host commands. Full access does not bypass operating-system permissions or authorize actions outside the user task.',
      guidelines: [
        `Use ${toolName} for ordinary commands, pipelines, scripts and project builds. Commands inherit the current full-access host execution mode; omit readOnly, including for ordinary queries. Read-only intent does not provide sandbox isolation or make a host command safe to run alongside writers.`,
        'Shells do not load user profiles. Use installed shims or explicit toolchain execution rather than assuming interactive activation. Full access does not authorize unrelated actions or bypass a declined request.',
      ],
    }
  }
  return {
    description: `Current mode: ${execution.readOnly ? 'read-only' : 'workspace-write'}. Commands run in an OS sandbox. Ordinary files are readable without directory approval. ${execution.readOnly ? 'The current profile already applies the read-only sandbox policy; commands cannot enable workspace writes.' : 'Sandbox policy permits writes only in authorized directories; readOnly optionally narrows this command to the read-only policy.'} Reads of known credential and application-private paths are denied. ${currentPlatform.id === OPERATING_SYSTEM.Windows ? `${WINDOWS_SANDBOX_FILESYSTEM_LIMITS} ` : ''}${networkBoundary} No automatic host fallback.`,
    guidelines: [
      execution.readOnly
        ? 'Commands already inherit the read-only sandbox policy. Omit readOnly for ordinary queries; readOnly=false cannot enable workspace writes. This policy does not freeze the filesystem while other commands write.'
        : 'Commands inherit the workspace-write sandbox policy. Use readOnly=true only to request a narrower read-only sandbox for a command that needs no workspace writes. This allows execution alongside writers but does not freeze the filesystem. It is an execution constraint, not a declaration of intent. Never silently retry a denied write with broader permissions.',
      `Use ${toolName} for ordinary commands, pipelines, scripts and project builds under the current permission mode. Ordinary reads need no approval. If the OS denies an ordinary directory, lexora_authorize_directory can prepare read access without a prompt. Do not retry protected credential paths through another interpreter or execution boundary.`,
      'In isolated modes, user HOME, configuration paths and supported toolchain variables are preserved; only temporary files use private TMPDIR/TEMP directories. Shells do not load user profiles. Use installed shims or explicit toolchain execution (for example, mise exec) rather than assuming interactive activation. Tool installation, cache and state writes outside authorized directories still require directory authorization. Host credential variables and desktop IPC variables are not inherited. Do not access protected credential paths or write repository Git metadata. Use lexora_authorize_directory with the least access needed for additional directories; additional write authorization expires with the current run. Windows may reuse read-access preparation and ACL material across runs; this does not authorize writes or other tools. Use lexora_host_shell only when the requested task genuinely needs host access; if its definition is missing, search that exact name with lexora_tool_search. Never use it to retry a request the user denied.',
    ],
  }
}
