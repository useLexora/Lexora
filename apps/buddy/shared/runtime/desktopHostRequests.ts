import type { extensionAgentRpc } from '../extensions/extensionAgent'
import type { extensionCapabilitiesRpc } from '../extensions/extensionCapabilities'
import type { extensionConditionSnapshotRpc } from '../extensions/extensionConditionContext'
import type { providerSpeechRpc } from '../providers/providerSpeechApi'
import type { attachmentHostRpc } from './attachmentHostProtocol'

export const inferenceLeaseRpc = {
  acquire: 'extensions.inference.acquire',
  release: 'extensions.inference.release',
} as const

export type DesktopHostRequestMethod
  = | typeof extensionAgentRpc.request
    | typeof inferenceLeaseRpc[keyof typeof inferenceLeaseRpc]
    | typeof extensionCapabilitiesRpc.impact | typeof extensionCapabilitiesRpc.apply
    | typeof extensionConditionSnapshotRpc.method
    | typeof providerSpeechRpc[keyof typeof providerSpeechRpc]['method']
    | typeof attachmentHostRpc.readPreview

export type DesktopClientRequestMethod<Method extends string> = Exclude<Method, DesktopHostRequestMethod>
