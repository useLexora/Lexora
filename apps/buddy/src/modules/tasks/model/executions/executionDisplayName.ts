import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'

export function executionDisplayName(execution: Pick<LocalExecution, 'buddyName' | 'ordinal'>, name = execution.buddyName): string {
  return execution.ordinal === null ? name : `#${execution.ordinal} ${name}`
}
