import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { ComposerDraftService } from './ComposerDraftService'
import { composerDraftsRpc } from '../../../shared/conversation/composerApi'

import { registerRuntimeRequest } from '../rpc/runtimeRequest'

export function registerComposerDraftRpc(options: {
  rpc: RuntimeRequestRegistrar
  service: ComposerDraftService
}): () => void {
  const disposers = [
    registerRuntimeRequest(options.rpc, composerDraftsRpc.find, params => options.service.find(params.draftId)),
    registerRuntimeRequest(options.rpc, composerDraftsRpc.discard, params => options.service.discard(params)),
    registerRuntimeRequest(options.rpc, composerDraftsRpc.list, () => options.service.list()),
    registerRuntimeRequest(options.rpc, composerDraftsRpc.open, params => options.service.open(
      params,
    )),
    registerRuntimeRequest(options.rpc, composerDraftsRpc.get, (params) => {
      const { draftId } = params
      return options.service.get(draftId)
    }),
    registerRuntimeRequest(options.rpc, composerDraftsRpc.save, params => options.service.save(
      params,
    )),
  ]
  return () => disposers.splice(0).forEach(dispose => dispose())
}
