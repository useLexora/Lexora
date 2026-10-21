import type { ExtensionShellDescriptor } from '../../../shared/extensions/extensionShell'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { ShellCandidate, ShellProgram } from '../../../shared/shell/shellProgram'
import type { BuddyToolDisclosurePolicy } from '../agent/extensions/discovery/toolDiscoveryContract'
import { currentPlatform } from '../../../platform/currentPlatform'
import { extensionShellDescriptorSchema, extensionShellRpc } from '../../../shared/extensions/extensionShell'

export const SHELL_COMMAND_TOOL_NAME = 'lexora_shell'
export const SYSTEM_SHELL_ID = 'system'
export const SHELL_COMMAND_DISCLOSURE: BuddyToolDisclosurePolicy = {
  source: { kind: 'builtin', id: 'shell', title: 'Shell command' },
  exposure: 'direct',
  keywords: 'shell command bash zsh sh powershell cmd 命令',
  tools: [{ name: SHELL_COMMAND_TOOL_NAME }],
}

export interface SelectedShell {
  id: string
  candidate: Readonly<ShellCandidate>
  program: Readonly<ShellProgram>
  extensionId: string
  revision: string
}

export class ShellSelection {
  readonly enabled: boolean
  readonly candidates: readonly SelectedShell[]
  readonly defaultId: string
  readonly #readCurrent: (signal?: AbortSignal) => Promise<ExtensionShellDescriptor[]>

  constructor(descriptors: readonly ExtensionShellDescriptor[], readCurrent: (signal?: AbortSignal) => Promise<ExtensionShellDescriptor[]>) {
    this.#readCurrent = readCurrent
    this.enabled = descriptors.length > 0
    this.candidates = descriptors.flatMap(descriptor => descriptor.candidates.map(candidate => Object.freeze({
      id: `${descriptor.extensionId}/${candidate.id}`,
      candidate: Object.freeze({ ...candidate, ...currentPlatform.hostShellSupervision ? {} : { available: false, reason: 'SHELL_SUPERVISION_UNAVAILABLE' } }),
      program: Object.freeze({ dialect: candidate.dialect, executable: candidate.executable }),
      extensionId: descriptor.extensionId,
      revision: descriptor.revision,
    })))
    const preferred = descriptors.flatMap(descriptor => descriptor.preferred.map(id => `${descriptor.extensionId}/${id}`))
    this.defaultId = preferred.find(id => this.candidates.some(entry => entry.id === id && entry.candidate.available)) ?? SYSTEM_SHELL_ID
  }

  resolve(id: unknown = this.defaultId): SelectedShell | undefined {
    if (id === SYSTEM_SHELL_ID)
      return undefined
    const selected = this.candidates.find(entry => entry.id === id)
    if (!selected)
      throw new Error('SHELL_CANDIDATE_NOT_ENABLED')
    if (!selected.candidate.available)
      throw new Error(`SHELL_CANDIDATE_UNAVAILABLE: ${selected.candidate.reason ?? selected.id}`)
    return selected
  }

  async assertCurrent(selected: SelectedShell | undefined, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (!selected)
      return
    const descriptors = await this.#readCurrent(signal)
    signal?.throwIfAborted()
    if (!descriptors.some(descriptor => descriptor.extensionId === selected.extensionId && descriptor.revision === selected.revision))
      throw new Error('SHELL_CONTRIBUTION_REVOKED')
  }
}

export class ExtensionShellRegistry {
  readonly #rpc: Pick<RuntimeRpcPeerContract, 'request'>

  constructor(rpc: Pick<RuntimeRpcPeerContract, 'request'>) {
    this.#rpc = rpc
  }

  async snapshot(signal?: AbortSignal): Promise<ShellSelection> {
    return new ShellSelection(await this.#list(signal), signal => this.#list(signal))
  }

  async #list(signal?: AbortSignal): Promise<ExtensionShellDescriptor[]> {
    const result = await this.#rpc.request(extensionShellRpc.list, {}, 30_000, signal)
    return extensionShellDescriptorSchema.array().parse(result)
  }
}
