<script setup lang="ts">
import type {
  DesktopAppInfo,
  DesktopUpdateCheckResult,
  DesktopWindowState,
} from '@buddy-electron/shared/desktopApi'
import type { DesktopCommandId } from '@buddy-electron/shared/desktopCommands'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { DESKTOP_COMMAND_REGISTRY, getDesktopCommand } from '@buddy-electron/shared/desktopCommands'
import { PanelRight20Regular } from '@vicons/fluent'
import { useMessage } from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, onScopeDispose, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import DesktopFeedbackDialog from '@/app/shell/window/DesktopFeedbackDialog.vue'
import DesktopUpdateDialog from '@/app/shell/window/DesktopUpdateDialog.vue'
import DesktopWindowMenuBar from '@/app/shell/window/DesktopWindowMenuBar.vue'
import { useDesktopWorkbenchContext } from '@/app/workbench/desktopWorkbenchContext'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  appInfo: DesktopAppInfo | null
  appSidebarCollapsed: boolean
  contextAvailable: boolean
  contextOpen: boolean
  language: BuddyLocale
  shortcutBindings: Readonly<Record<string, readonly string[]>>
}>()
const emit = defineEmits<{
  toggleAppSidebar: []
  toggleContext: []
}>()

const desktopApi = requireDesktopApi()
const router = useRouter()
const isMaximized = shallowRef(false)
const showFeedback = shallowRef(false)
const showUpdate = shallowRef(false)
const updateResult = shallowRef<DesktopUpdateCheckResult | null>(null)
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const platform = computed(() => props.appInfo?.platform ?? 'linux')
const maximizeLabel = computed(() => isMaximized.value
  ? t('desktop.window.restore')
  : t('desktop.window.maximize'))
let windowStateVersion = 0

const rendererCommandHandlers = {
  'app.about': () => router.push(desktopRouteLocations.settings('about')),
  'app.checkUpdates': checkForUpdates,
  'help.feedback': () => showFeedback.value = true,
} satisfies Partial<Record<DesktopCommandId, () => void>>

const stopWindowState = desktopApi.window.onStateChanged((state) => {
  windowStateVersion += 1
  applyWindowState(state)
})

onMounted(async () => {
  const snapshotVersion = windowStateVersion
  try {
    const state = await desktopApi.window.getState()
    if (snapshotVersion === windowStateVersion)
      applyWindowState(state)
  }
  catch (error) {
    console.error('Lexora window state is unavailable', error)
  }
})

onBeforeUnmount(stopWindowState)

const { controller } = useDesktopWorkbenchContext()
onScopeDispose(controller.registry.register('lexora.desktopCommands', (scope) => {
  for (const command of DESKTOP_COMMAND_REGISTRY) {
    scope.command({
      id: command.id,
      get label() { return t(`desktop.command.${command.id}`) },
      get keybinding() { return platform.value === 'darwin' ? command.macosKeybinding ?? command.keybinding : command.keybinding },
      alternateKeybindings: command.alternateKeybindings,
      shortcutScope: 'application',
      execute: () => executeDesktopCommand(command.id),
    })
  }
}))

async function executeDesktopCommand(commandId: DesktopCommandId) {
  try {
    const command = getDesktopCommand(commandId)
    if (command.execution === 'main') {
      await desktopApi.commands.execute(commandId)
      return
    }
    const handler = rendererCommandHandlers[commandId as keyof typeof rendererCommandHandlers]
    if (!handler)
      throw new Error(`Desktop command has no renderer handler: ${commandId}`)
    await handler()
  }
  catch (error) {
    console.error(`Lexora Buddy Desktop command ${commandId} failed`, error)
    message.error(t('desktop.command.failed'))
  }
}

async function toggleMaximize() {
  await runWindowAction(() => desktopApi.window.toggleMaximize())
}

async function minimize() {
  try {
    await desktopApi.window.minimize()
  }
  catch (error) {
    console.error('Lexora window action failed', error)
  }
}

async function checkForUpdates() {
  try {
    updateResult.value = await desktopApi.app.checkForUpdates()
    showUpdate.value = true
  }
  catch (error) {
    console.error('Lexora Buddy update check failed', error)
    message.error(t('desktop.update.failed'))
  }
}

async function openFeedbackIssue(feedback: string) {
  try {
    await desktopApi.app.openFeedbackIssue(feedback)
    showFeedback.value = false
  }
  catch (error) {
    console.error('Lexora Buddy feedback page is unavailable', error)
    message.error(t('desktop.command.failed'))
  }
}

async function openReleasePage(url: string) {
  try {
    await desktopApi.app.openReleasePage(url)
  }
  catch (error) {
    console.error('Lexora Buddy release page is unavailable', error)
    message.error(t('desktop.command.failed'))
  }
}

async function runWindowAction(action: () => Promise<DesktopWindowState>) {
  try {
    applyWindowState(await action())
  }
  catch (error) {
    console.error('Lexora window action failed', error)
  }
}

function applyWindowState(state: DesktopWindowState) {
  isMaximized.value = state.isMaximized
}
</script>

<template>
  <header class="desktop-title-bar" @dblclick="toggleMaximize">
    <div class="desktop-title-bar__safe-area">
      <DesktopWindowMenuBar
        :app-sidebar-collapsed="appSidebarCollapsed"
        :language="language"
        :shortcut-bindings="shortcutBindings"
        :platform="platform"
        @command="executeDesktopCommand"
        @toggle-app-sidebar="emit('toggleAppSidebar')"
      />

      <div
        class="desktop-title-bar__controls"
        @dblclick.stop
        @mousedown.stop
        @pointerdown.stop
      >
        <button
          v-if="contextAvailable"
          :aria-label="t(contextOpen ? 'desktop.context.collapse' : 'desktop.context.open')"
          :aria-expanded="contextOpen"
          class="desktop-title-bar__control"
          :class="{ 'is-active': contextOpen }"
          data-testid="context-panel-toggle"
          type="button"
          @click="emit('toggleContext')"
        >
          <DesktopIcon :component="PanelRight20Regular" />
        </button>
        <button
          :aria-label="t('desktop.window.minimize')"
          class="desktop-title-bar__control"
          type="button"
          @click="minimize"
        >
          <DesktopIcon data-window-control-icon="minimize" name="windowMinimize" />
        </button>
        <button
          :aria-label="maximizeLabel"
          class="desktop-title-bar__control"
          type="button"
          @click="toggleMaximize"
        >
          <DesktopIcon
            v-if="isMaximized"
            data-window-control-icon="restore"
            name="windowRestore"
          />
          <DesktopIcon
            v-else
            data-window-control-icon="maximize"
            name="windowMaximize"
          />
        </button>
        <button
          :aria-label="t('desktop.command.window.close')"
          class="desktop-title-bar__control is-close"
          type="button"
          @click="executeDesktopCommand('window.close')"
        >
          <DesktopIcon data-window-control-icon="close" name="windowClose" />
        </button>
      </div>
    </div>

    <DesktopFeedbackDialog
      v-model:show="showFeedback"
      :language="language"
      @open-github-issue="openFeedbackIssue"
    />
    <DesktopUpdateDialog
      v-model:show="showUpdate"
      :language="language"
      :result="updateResult"
      @open-release="openReleasePage"
    />
  </header>
</template>

<style scoped>
.desktop-title-bar {
  position: relative;
  height: var(--buddy-titlebar-height);
  flex: none;
  border-bottom: 1px solid var(--buddy-border-subtle);
  background: var(--buddy-surface-canvas);
  color: var(--buddy-text-strong);
  user-select: none;
  -webkit-app-region: drag;
}

.desktop-title-bar__safe-area {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.desktop-title-bar__controls {
  display: flex;
  height: var(--buddy-titlebar-height);
  flex: none;
  align-self: center;
  -webkit-app-region: no-drag;
}

.desktop-title-bar__control {
  display: grid;
  width: var(--buddy-titlebar-height);
  height: var(--buddy-titlebar-height);
  flex: none;
  place-items: center;
  border: 0;
  border-radius: var(--buddy-radius-micro);
  background: transparent;
  color: var(--buddy-text-secondary);
  cursor: default;

  &:hover {
    background: var(--buddy-state-hover);
    color: var(--buddy-text-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }

  &.is-active {
    color: var(--buddy-accent-text);
  }

  &.is-close:hover {
    background: var(--buddy-status-danger-solid);
    color: var(--buddy-text-on-accent);
  }

  .desktop-icon {
    width: 1rem;
    height: 1rem;
  }
}
</style>
