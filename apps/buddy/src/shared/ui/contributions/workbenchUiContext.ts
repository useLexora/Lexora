import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { WorkbenchContextValues } from '@buddy-shared/workbench/workbenchContext'
import type { JsonValue } from '@buddy-shared/workbench/workbenchState'
import type { ComposerActivity, WorkbenchAnchor, WorkbenchControl, WorkbenchMenu } from '@buddy-shared/workbench/workbenchUi'
import type { Component } from 'vue'
import { createInjectionState } from '@vueuse/core'
import { watch } from 'vue'

export interface SemanticAnchor {
  id: string
  kind: WorkbenchAnchor
  element: HTMLElement
  caret?: () => DOMRect | null
}
export interface WorkbenchAnchors {
  readonly entries: ReadonlyMap<string, SemanticAnchor>
  register: (kind: WorkbenchAnchor, element: HTMLElement, caret?: () => DOMRect | null) => () => void
  onActivity: (listener: (anchor: SemanticAnchor, activity: ComposerActivity) => void) => () => void
}
export interface WorkbenchControlProps {
  target: WorkbenchControl
  contextKey: string
  value: string | null
  options: readonly { value: string, label: string }[]
  disabled: boolean
}
export interface WorkbenchUiHost {
  anchors: WorkbenchAnchors
  panes?: { register: (id: string | null, element: HTMLElement) => () => void }
  controlRenderer: Component
  slotRenderer: Component
  menuRenderer: Component
}
export interface WorkbenchMenuSelection {
  content?: string
  resource?: SpaceFileTarget
  apply?: (result: JsonValue) => void
}
export interface WorkbenchMenuProps {
  target: WorkbenchMenu
  disabled?: boolean
  values?: WorkbenchContextValues
  capture?: () => WorkbenchMenuSelection
}
const [useProvideWorkbenchUi, useOptionalWorkbenchUi] = createInjectionState((host: WorkbenchUiHost) => host)
export { useOptionalWorkbenchUi, useProvideWorkbenchUi }
const [useProvideWorkbenchUiScope, useWorkbenchUiScope] = createInjectionState((scope: { instanceId: () => string | undefined }) => scope)
export { useProvideWorkbenchUiScope, useWorkbenchUiScope }

export function useWorkbenchAnchor(kind: WorkbenchAnchor, element: () => HTMLElement | null, caret?: () => DOMRect | null): void {
  const host = useOptionalWorkbenchUi()
  if (!host)
    return
  watch(element, (element, _, cleanup) => {
    if (element)
      cleanup(host.anchors.register(kind, element, caret))
  }, { immediate: true, flush: 'post' })
}
