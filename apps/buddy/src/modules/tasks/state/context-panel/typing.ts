import type { DesktopContextPanelMode } from '@buddy-electron/shared/desktopApi'
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { ContextPanelApi } from '@buddy-shared/context-panel/contextPanel'
import type { LocalRunOutput } from '@buddy-shared/runs/runApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { Ref } from 'vue'

export interface UseTaskContextPanelOptions {
  mode: Readonly<Ref<DesktopContextPanelMode>>
  control: ContextPanelApi
  onError: () => void
  activeBranchId: Readonly<Ref<string | null>>
  activeRunId: Readonly<Ref<string | null>>
  taskVisible: Readonly<Ref<boolean>>
  spaces: Readonly<Ref<ReadonlyArray<LocalSpace>>>
  activeSpace?: Readonly<Ref<LocalSpace | null>>
  activeConversationId: Readonly<Ref<string | null>>
  activeDraftId: Readonly<Ref<string | null>>
  changeSets: Readonly<Ref<ReadonlyArray<LocalChangeSetSummary>>>
  runOutputs: Readonly<Ref<ReadonlyArray<LocalRunOutput>>>
}
