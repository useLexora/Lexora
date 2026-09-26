import type { WorkbenchSlashCommand } from '@buddy-shared/workbench/workbenchCommand'
import type { JsonValue } from '@buddy-shared/workbench/workbenchState'
import type { Ref } from 'vue'
import { createInjectionState } from '@vueuse/core'

export interface WorkbenchCommandPort {
  entries: Readonly<Ref<readonly WorkbenchSlashCommand[]>>
  reportFailure: () => void
  execute: (id: string, argumentsText: string, instanceId?: string) => Promise<JsonValue>
}
export const [useProvideWorkbenchCommands, useWorkbenchCommands] = createInjectionState((commands: WorkbenchCommandPort) => commands)
