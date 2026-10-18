<script setup lang="ts">
import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { SpaceFileOperation, SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ExplorerNode } from '@/shared/ui/explorer/treeCollection'
import { DocumentAdd20Regular, FolderAdd20Regular, SubtractSquare20Regular } from '@vicons/fluent'
import { NDropdown, NSpin } from 'naive-ui'
import { computed, onMounted, onScopeDispose, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { loadDesktopAppInfo } from '@/platform/desktop/desktopCapabilities'
import ExplorerTree from '@/shared/ui/explorer/ExplorerTree.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopFileLoading from '@/shared/ui/loading/DesktopFileLoading.vue'
import { useDelayedLoading } from '@/shared/ui/loading/useDelayedLoading'
import ExplorerNameDialog from './ExplorerNameDialog.vue'
import ExplorerRecovery from './ExplorerRecovery.vue'
import { useExplorerCommands } from './useExplorerCommands'

const props = defineProps<{
  nodes: readonly ExplorerNode[]
  loadingKeys: ReadonlySet<string>
  target: SpaceFileTarget
  language: BuddyLocale
  api: Pick<LocalChatApi['spaces'], 'revealFile' | 'copyFilePath' | 'fileHistory' | 'acknowledgeFileOperation' | 'cancelFileOperation' | 'onFilesChanged'>
  load: (node: ExplorerNode) => Promise<void>
  refresh: () => Promise<void>
}>()
const emit = defineEmits<{ select: [key: string] }>()
const showRefreshing = useDelayedLoading(() => props.loadingKeys.has('') && props.nodes.length > 0)
const { t } = useBuddyI18n(() => props.language)
const expandedKeys = defineModel<string[]>('expandedKeys', { required: true })
const menu = shallowRef<{ node: ExplorerNode | null } | null>(null)
const menuPosition = shallowRef({ x: 0, y: 0 })
const recoveryOperations = shallowRef<SpaceFileOperation[]>([])
const platform = shallowRef<string | null>(null)
const commands = useExplorerCommands({
  target: () => props.target,
  language: () => props.language,
  api: props.api,
  refresh: async () => {
    await props.refresh()
    await refreshRecovery()
  },
})
const { labels, busy, error, nameRequest, clipboard } = commands
onMounted(async () => {
  try {
    platform.value = (await loadDesktopAppInfo()).platform
  }
  catch { error.value = labels.value.failure }
})
const menuOptions = computed(() => [
  { key: 'newFile', label: labels.value.newFile },
  { key: 'newFolder', label: labels.value.newFolder },
  { key: 'rename', label: labels.value.rename, disabled: !menu.value?.node },
  { key: 'copy', label: labels.value.copy, disabled: !menu.value?.node },
  { key: 'copyPath', label: labels.value.copyPath, disabled: !menu.value?.node },
  { key: 'cut', label: labels.value.cut, disabled: !menu.value?.node },
  { key: 'paste', label: labels.value.paste, disabled: !clipboard.value },
  { key: 'trash', label: labels.value.trash, disabled: !menu.value?.node },
  { key: 'reveal', label: labels.value.reveal },
  { key: 'refresh', label: labels.value.refresh },
])
async function refreshRecovery() {
  const target = { ...props.target }
  try {
    const result = await props.api.fileHistory(target)
    if (props.target.directoryId === target.directoryId && props.target.revision === target.revision)
      recoveryOperations.value = result.filter(operation => operation.status === 'needs-recovery')
  }
  catch { error.value = labels.value.failure }
}
watch(() => `${props.target.directoryId}:${props.target.revision}`, () => {
  recoveryOperations.value = []
  void refreshRecovery()
}, { immediate: true })
let timer: ReturnType<typeof setTimeout> | undefined
onScopeDispose(props.api.onFilesChanged((event) => {
  if (event.directoryId !== props.target.directoryId || event.directoryRevision !== props.target.revision)
    return
  clearTimeout(timer)
  timer = setTimeout(() => void refreshRecovery(), 250)
}))
onScopeDispose(() => clearTimeout(timer))
function contextmenu(node: ExplorerNode | null, event: MouseEvent) {
  if (!busy.value) {
    menuPosition.value = { x: event.clientX, y: event.clientY }
    menu.value = { node }
  }
}
function selectCommand(command: string) {
  const node = menu.value?.node ?? null
  menu.value = null
  void commands.command(command, node)
}
async function acknowledge(operation: SpaceFileOperation) {
  await props.api.acknowledgeFileOperation({ ...props.target, operationId: operation.operationId }).catch(() => error.value = labels.value.recoveryFailure)
  await refreshRecovery()
}
</script>

<template>
  <div class="workspace-explorer flex min-h-0 flex-1 flex-col">
    <div class="explorer-toolbar">
      <span class="explorer-root truncate">{{ target.path ? target.path.split('/').slice(0, -1).join('/') || '/' : '/' }}</span>
      <NSpin v-if="showRefreshing" :size="12" class="mr-[4px]" />
      <button type="button" :aria-label="labels.newFile" :disabled="!!busy" @click="commands.command('newFile', null)">
        <DesktopIcon :component="DocumentAdd20Regular" :size="16" />
      </button>
      <button type="button" :aria-label="labels.newFolder" :disabled="!!busy" @click="commands.command('newFolder', null)">
        <DesktopIcon :component="FolderAdd20Regular" :size="16" />
      </button>
      <button type="button" :aria-label="labels.collapse" @click="expandedKeys = []">
        <DesktopIcon :component="SubtractSquare20Regular" :size="16" />
      </button>
    </div>
    <div v-if="busy" class="explorer-notice" role="status">
      <span>{{ labels.busy }}</span><button @click="commands.cancel()">
        {{ labels.cancel }}
      </button>
    </div>
    <div v-if="error" class="explorer-notice" role="alert">
      <span>{{ error }}</span>
    </div>
    <div class="relative flex min-h-0 flex-1 flex-col">
      <DesktopFileLoading v-if="!nodes.length && loadingKeys.has('')" class="absolute inset-0" :loading="true" tree :label="t('desktop.loading.pane')" />
      <ExplorerTree v-model:expanded-keys="expandedKeys" :loading-keys="loadingKeys" :aria-busy="loadingKeys.has('')" :nodes="nodes" :selected-key="target.path || null" :language="language" :load="load" @select="emit('select', $event)" @contextmenu="contextmenu" @command="commands.command" />
    </div>
    <ExplorerRecovery v-if="recoveryOperations.length" :operations="recoveryOperations" :language="language" :busy="!!busy" @acknowledge="acknowledge" />
    <NDropdown :show="!!menu" :x="menuPosition.x" :y="menuPosition.y" :options="menuOptions" trigger="manual" placement="bottom-start" @select="selectCommand" @clickoutside="menu = null" />
    <ExplorerNameDialog :request="nameRequest" :language="language" :platform="platform" @finish="commands.finishName" />
  </div>
</template>

<style scoped lang="scss">
.explorer-toolbar {
  display: flex;
  align-items: center;
  min-height: 28px;
  padding: 0 6px 0 12px;
  gap: 2px;
  color: var(--buddy-text-secondary);
}
.explorer-root {
  flex: 1;
  font-size: 11px;
}
.explorer-toolbar button {
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: inherit;
  width: 24px;
  height: 24px;
  border-radius: var(--buddy-icon-button-radius);
  cursor: pointer;
  font-size: 16px;
}
.explorer-toolbar button:hover {
  background: var(--buddy-state-hover);
  color: var(--buddy-text-primary);
}
.explorer-notice {
  padding: 6px 10px;
  font-size: 11px;
  color: var(--buddy-status-warning-text);
  display: flex;
  gap: 6px;
}
.explorer-notice button {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
</style>
