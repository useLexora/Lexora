import type { RuntimeRequestRegistrar } from './runtimeRequest'

const queries = new Set([
  'runs.get',
  'runs.list',
  'runs.listEvents',
  'runs.isBusy',
  'chat.queue.list',
  'composerDrafts.find',
  'composerDrafts.get',
  'composerDrafts.list',
  'conversations.get',
  'conversations.list',
  'conversations.listMembers',
  'conversations.getModelControls',
  'conversations.listBranches',
  'conversations.listMessages',
  'conversations.listTimeline',
  'conversations.listHistory',
  'conversations.getHistoryEntries',
  'taskMarks.list',
  'taskMarks.states',
  'approvals.list',
  'approvals.getReview',
  'questions.list',
])

export class ProductCommandRequiredError extends Error {
  readonly code = 'METHOD_NOT_AVAILABLE'

  constructor() {
    super('This operation requires the product command protocol')
    this.name = 'ProductCommandRequiredError'
  }
}

export function candidateLegacyRegistrar(rpc: RuntimeRequestRegistrar): RuntimeRequestRegistrar {
  return {
    onRequest: (method, handler) => rpc.onRequest(method, queries.has(method) ? handler : () => { throw new ProductCommandRequiredError() }),
  }
}
