<script setup lang="ts">
import type { WorkbenchMountTarget } from '@buddy-shared/workbench/workbenchUi'
import type { DragEndEvent } from '@dnd-kit/vue'
import type { DropPosition, ResourceRef, WorkbenchView } from '../common/workbench'
import type { WorkbenchController } from '../services/WorkbenchController'
import type { WorkingCopyService } from '../services/WorkingCopyService'
import { formatKeybinding, matchesKeybinding } from '@buddy-shared/shortcuts/keybinding'
import { workbenchMountKey } from '@buddy-shared/workbench/workbenchUi'
import { PointerActivationConstraints } from '@dnd-kit/dom'
import { DragDropProvider, DragOverlay, KeyboardSensor, PointerSensor } from '@dnd-kit/vue'
import { NInput, NModal } from 'naive-ui'
import { computed, onMounted, onScopeDispose, provide, shallowRef, triggerRef } from 'vue'
import { useOptionalWorkbenchUi } from '@/shared/ui/contributions/workbenchUiContext'
import { workbenchLabels } from '../common/workbenchLabels'
import WorkbenchMountPortals from './mounts/WorkbenchMountPortals.vue'
import { useWorkbenchResize } from './useWorkbenchResize'
import { workbenchKey } from './workbenchContext'
import { createWorkbenchDragPlugins } from './workbenchDragPlugins'
import WorkbenchInteractionControls from './WorkbenchInteractionControls.vue'
import WorkbenchViewPortals from './WorkbenchViewPortals.vue'

const props = defineProps<{ controller: WorkbenchController, copies: WorkingCopyService, language: string, backupError: boolean, active: boolean, keybindings: Readonly<Record<string, readonly string[]>>, platform: string }>()
const emit = defineEmits<{ retryBackup: [], dropResource: [resource: ResourceRef, paneId: string, position: DropPosition] }>()
defineSlots<{ default: () => unknown, view: (props: { view: WorkbenchView, visible: boolean }) => unknown }>()
const ui = useOptionalWorkbenchUi()
const plugins = createWorkbenchDragPlugins()
const sensors = [PointerSensor.configure({ activationConstraints: () => [new PointerActivationConstraints.Distance({ value: 6 })] }), KeyboardSensor]
const resize = useWorkbenchResize(props.controller)
const layout = shallowRef(props.controller.layout)
const revision = shallowRef(0)
const labels = computed(() => workbenchLabels(props.language))
const palette = shallowRef(false)
const query = shallowRef('')
const commandFailed = shallowRef(false)
const dragging = shallowRef(false)
const mountPoints = shallowRef(new Map<string, HTMLElement>())
function registerMountPoint(target: WorkbenchMountTarget, element: HTMLElement, instanceId?: string): () => void {
  const unregisterPane = target === 'workbench' || (target === 'workbench.pane' && instanceId) ? ui?.panes?.register(target === 'workbench' ? null : instanceId!, element) : undefined
  const key = workbenchMountKey(target, instanceId)
  mountPoints.value = new Map(mountPoints.value).set(key, element)
  return () => {
    unregisterPane?.()
    if (mountPoints.value.get(key) === element) {
      const next = new Map(mountPoints.value)
      next.delete(key)
      mountPoints.value = next
    }
  }
}
const mounts = shallowRef(new Map<string, HTMLElement>())
function mountView(id: string, element: HTMLElement): () => void {
  mounts.value = new Map(mounts.value).set(id, element)
  return () => {
    if (mounts.value.get(id) === element) {
      const next = new Map(mounts.value)
      next.delete(id)
      mounts.value = next
    }
  }
}
function refresh() {
  layout.value = props.controller.layout
  triggerRef(layout)
  revision.value++
}
onScopeDispose(props.controller.subscribe(refresh))
onScopeDispose(props.copies.subscribe(refresh))
const commands = computed(() => {
  void revision.value
  return [...props.controller.registry.commands.values()].filter(command => command.label.toLowerCase().includes(query.value.toLowerCase()) && (!command.enabled || command.enabled(props.controller.context)))
})
const dropPosition = shallowRef<{ paneId: string, position: DropPosition } | null>(null)
function viewVisible(id: string): boolean {
  const view = props.controller.layout.views[id]
  return !!view && mounts.value.has(id) && (props.active || view.location !== 'main') && props.controller.matchesViewContext(view)
}
function viewTarget(id: string): HTMLElement | null {
  return mounts.value.get(id) ?? null
}
async function execute(id: string) {
  palette.value = false
  commandFailed.value = false
  try {
    await props.controller.registry.execute(id, props.controller.context)
  }
  catch {
    commandFailed.value = true
  }
}
function dragEnd(event: DragEndEvent) {
  dragging.value = false
  const destination = dropPosition.value
  dropPosition.value = null
  if (event.canceled || !destination)
    return
  const source = event.operation.source
  if (source?.data.resource)
    emit('dropResource', source.data.resource as ResourceRef, destination.paneId, destination.position)
}
onScopeDispose(props.controller.registry.register('lexora.commandPalette', (scope) => {
  scope.command({ id: 'command.palette', get label() {
    return labels.value.commands
  }, keybinding: 'Mod+Shift+P', shortcutScope: 'application', execute: () => {
    palette.value = !palette.value
    query.value = ''
  } })
}))
const interactions = computed(() => {
  void revision.value
  return [...props.controller.interactions.entries.values()]
})
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && interactions.value.length) {
    event.preventDefault()
    props.controller.interactions.end(interactions.value.at(-1)!.id)
    return
  }
  if (event.isComposing || event.defaultPrevented || event.repeat)
    return
  if ((event.target as Element | null)?.closest('[role="dialog"], .n-modal'))
    return
  const context = props.controller.context
  const focusedContext = context.values['focus.area'] === 'context' && !!document.activeElement?.closest('[data-workbench-context]')
  const command = [...props.controller.registry.commands.values()].find((item) => {
    if (item.shortcutScope !== 'application' && !props.active && !focusedContext)
      return false
    if (item.shortcutScope === 'main' && (focusedContext || !props.active))
      return false
    if (item.shortcutScope === 'context' && context.values['focus.area'] !== 'context')
      return false
    return (!item.enabled || item.enabled(context)) && props.keybindings[item.id]?.some(binding => matchesKeybinding(event, binding, props.platform))
  })
  if (command) {
    event.preventDefault()
    void execute(command.id)
  }
}
onMounted(() => {
  window.addEventListener('keydown', keyboard)
})
onScopeDispose(() => window.removeEventListener('keydown', keyboard))
provide(workbenchKey, { resize, controller: props.controller, copies: props.copies, layout, revision, mountPoints, registerMountPoint, labels, viewVisible, viewTarget, mountView, dropPosition })
</script>

<template>
  <DragDropProvider :sensors="sensors" :plugins="plugins" @drag-start="dragging = true" @drag-end="dragEnd">
    <main class="workbench" :class="{ 'is-dragging': dragging, 'is-resizing': resize.active.value.length > 0 }" :style="{ '--workbench-resize-cursor': resize.cursor.value }" data-testid="workbench">
      <div v-if="backupError" class="workbench__error" role="alert">
        {{ labels.backupFailed }} <button type="button" @click="emit('retryBackup')">
          {{ labels.retry }}
        </button>
      </div>
      <div v-if="commandFailed" class="workbench__error" role="alert" @click="commandFailed = false">
        {{ labels.commandFailed }}
      </div>
      <slot />
      <div v-if="resize.active.value.length" class="workbench__resize-shield" />
      <WorkbenchInteractionControls :entries="interactions" :language="language" @end="controller.interactions.end($event)" />
      <WorkbenchMountPortals />
      <WorkbenchViewPortals>
        <template #default="{ view, visible }">
          <slot name="view" :view="view" :visible="visible" />
        </template>
      </WorkbenchViewPortals>
      <NModal v-model:show="palette" preset="card" :title="labels.commands" style="width: min(580px, 90vw); margin-top: 12vh" :bordered="false">
        <NInput v-model:value="query" :placeholder="labels.searchCommands" autofocus @keydown.enter.prevent.stop="commands[0] && execute(commands[0].id)" />
        <div class="workbench__commands">
          <button v-for="command in commands" :key="command.id" type="button" @click="execute(command.id)">
            <span>{{ command.label }}</span><kbd v-if="keybindings[command.id]?.[0]">{{ formatKeybinding(keybindings[command.id]![0]!, platform) }}</kbd>
          </button>
        </div>
      </NModal>
    </main>
    <DragOverlay :drop-animation="null">
      <template #default="{ source }">
        <div class="workbench__drag-preview">
          {{ source.data.title }}
        </div>
      </template>
    </DragOverlay>
  </DragDropProvider>
</template>

<style scoped>
.workbench { position: relative; display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; }
.workbench__drag-preview { padding: 8px 12px; color: var(--buddy-text-primary); background: var(--buddy-surface-raised); border: 1px solid var(--buddy-accent-solid); border-radius: 4px; font-size: 12px; }
.workbench__error { padding: 6px 12px; color: var(--buddy-text-primary); background: var(--buddy-state-hover); }
.workbench__commands { display: flex; flex-direction: column; max-height: 50vh; overflow: auto; margin-top: 10px; }
.workbench__commands button { display: flex; justify-content: space-between; border: none; background: none; color: inherit; padding: 10px 8px; cursor: pointer; }
.workbench__commands button:hover, .workbench__commands button:focus-visible { background: var(--buddy-state-hover); }
.workbench__resize-shield { position: fixed; inset: 0; z-index: 9999; cursor: var(--workbench-resize-cursor); }
.workbench.is-resizing { user-select: none; }
.workbench.is-dragging { user-select: none; }
.workbench.is-dragging :deep(.workbench__view) { pointer-events: none; }
:global(body:has(.workbench.is-dragging)) { user-select: none !important; }
:global(body:has(.workbench.is-dragging) webview) { pointer-events: none !important; }
</style>
