<script setup lang="ts">
import type { DesktopShellBindings } from './desktopShellBindings'
import { NDrawer, useMessage } from 'naive-ui'
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DesktopStartupScreen from '@/app/bootstrap/DesktopStartupScreen.vue'
import DesktopAppSidebar from '@/app/shell/DesktopAppSidebar.vue'
import DesktopImmersiveNavigation from '@/app/shell/DesktopImmersiveNavigation.vue'
import DesktopTitleBar from '@/app/shell/window/DesktopTitleBar.vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DesktopFeatureDiscovery, DesktopOnboardingScreen } from '@/modules/onboarding/ui'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { useWorkbenchAnchor } from '@/shared/ui/contributions/workbenchUiContext'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import WorkbenchMountPoint from '@/workbench/browser/mounts/WorkbenchMountPoint.vue'
import WorkbenchHost from '@/workbench/browser/WorkbenchHost.vue'
import DesktopTaskHistory from '../workbench/DesktopTaskHistory.vue'
import DesktopWorkbenchArea from '../workbench/DesktopWorkbenchArea.vue'
import DesktopWorkbenchView from '../workbench/DesktopWorkbenchView.vue'

const { bindings } = defineProps<{ bindings: DesktopShellBindings }>()
const route = useRoute()
const router = useRouter()
const { appSidebarCollapsed, language } = useDesktopUi()
const windowElement = useTemplateRef<HTMLElement>('windowElement')
useWorkbenchAnchor('window', () => windowElement.value)
const hasBeenReady = computed(() => bindings.lifecycle.state.value.hasBeenReady)
const startupVisible = computed(() => !hasBeenReady.value && route.meta.requiresRuntime !== false)
const onboardingPending = bindings.onboarding.pending
const onboardingVisible = computed(() => onboardingPending.value && hasBeenReady.value)
const blocked = computed(() => startupVisible.value || onboardingVisible.value)
const activeView = computed(() => bindings.pages.current.value)
const navigation = computed(() => bindings.pages.navigation.value)
const navigationLayout = bindings.navigationLayout
const historyDrawerOpen = shallowRef(false)
const tasksVisible = computed(() => activeView.value === 'lexora.tasks')
const primarySidebarCollapsed = computed(() => navigationLayout.value === 'full'
  ? appSidebarCollapsed.value
  : tasksVisible.value ? bindings.taskIndex.sidebar.collapsed.value : !historyDrawerOpen.value)
const historyDrawerWidth = computed(() => Math.max(232, bindings.taskIndex.sidebar.width.value ?? 248))
const message = useMessage()
const { t } = useBuddyI18n(language)
watch([activeView, navigationLayout], () => historyDrawerOpen.value = false)

async function togglePrimarySidebar() {
  if (navigationLayout.value === 'full') {
    bindings.toggleAppSidebar()
  }
  else if (tasksVisible.value) {
    if (!await bindings.taskIndex.sidebar.setCollapsed(!bindings.taskIndex.sidebar.collapsed.value))
      message.error(t('desktop.settings.saveFailed'))
  }
  else {
    historyDrawerOpen.value = !historyDrawerOpen.value
  }
}
function navigate(id: string) {
  const entry = navigation.value.find(entry => entry.id === id)
  if (entry) {
    historyDrawerOpen.value = false
    void bindings.navigation.navigate(entry.location)
  }
}
function showTasks() {
  historyDrawerOpen.value = false
  void bindings.navigation.navigate(desktopRouteLocations.tasks())
}
</script>

<template>
  <div ref="windowElement" class="desktop-shell relative flex min-w-0 min-h-0 flex-col bg-canvas" data-theme-surface="layout" :data-lexora-page="activeView" :data-navigation-layout="navigationLayout">
    <DesktopTitleBar
      :app-info="bindings.appInfo.value"
      :minimal="onboardingVisible"
      :shortcut-bindings="bindings.shortcuts.bindings.value"
      :sidebar-collapsed="primarySidebarCollapsed"
      :sidebar-target="navigationLayout === 'full' ? 'app' : 'history'"
      :language="language"
      :context-available="hasBeenReady && !onboardingPending && (bindings.contextPanelGlobal.value || activeView === 'lexora.tasks')"
      :context-open="bindings.resources.isOpen.value"
      @toggle-context="bindings.resources.toggle"
      @toggle-sidebar="togglePrimarySidebar"
    />
    <div class="desktop-shell__body relative">
      <WorkbenchHost :keybindings="bindings.shortcuts.bindings.value" :platform="bindings.shortcuts.platform.value" :active="hasBeenReady && !onboardingPending && activeView === 'lexora.tasks'" :controller="bindings.workbench.controller" :copies="bindings.workbench.copies" :auto-save="bindings.workbench.autoSave" :language="language" :backup-error="bindings.workbench.backupError.value" @drop-resource="bindings.workbench.dropResource" @retry-backup="bindings.workbench.persistence.flush()">
        <div class="desktop-shell__content" :class="{ 'is-starting': blocked }" :inert="blocked" :aria-hidden="blocked">
          <Transition name="desktop-app-sidebar">
            <DesktopAppSidebar
              v-if="navigationLayout === 'compact' || (navigationLayout === 'full' && !appSidebarCollapsed)"
              :bindings="bindings" :compact="navigationLayout === 'compact'" @navigate="navigate"
            />
          </Transition>
          <WorkbenchMountPoint target="workbench" class="desktop-shell__workbench" data-theme-surface="layout">
            <DesktopWorkbenchArea :bindings="bindings" :tasks-visible="tasksVisible">
              <template v-if="navigationLayout === 'immersive'" #sidebar-footer>
                <DesktopImmersiveNavigation :bindings="bindings" :visible="!bindings.taskIndex.sidebar.collapsed.value" @navigate="navigate" />
              </template>
            </DesktopWorkbenchArea>
          </WorkbenchMountPoint>
        </div>
        <NDrawer
          v-if="navigationLayout !== 'full' && !tasksVisible"
          v-model:show="historyDrawerOpen" class="desktop-history-drawer" placement="left" :width="historyDrawerWidth"
          :style="{ '--buddy-workspace-sidebar-width': `${historyDrawerWidth}px` }" to=".desktop-shell__body"
        >
          <DesktopTaskHistory :bindings="bindings" @navigate="showTasks">
            <template v-if="navigationLayout === 'immersive'" #footer>
              <DesktopImmersiveNavigation :bindings="bindings" :visible="historyDrawerOpen" @navigate="navigate" />
            </template>
          </DesktopTaskHistory>
        </NDrawer>
        <template #view="{ view, visible }">
          <DesktopWorkbenchView :view="view" :visible="visible" />
        </template>
      </WorkbenchHost>
      <DesktopOnboardingScreen v-if="onboardingVisible && !startupVisible" :controller="bindings.onboarding" :app-info="bindings.appInfo.value" />
      <Transition name="desktop-startup-reveal">
        <DesktopStartupScreen
          v-if="startupVisible"
          :failed="bindings.lifecycle.failed.value"
          :language="language"
          @retry="bindings.lifecycle.retry()"
          @open-logs="router.push(desktopRouteLocations.settings('logs'))"
          @open-storage="router.push(desktopRouteLocations.settings('storage'))"
        />
      </Transition>
    </div>
    <DesktopFeatureDiscovery v-if="!blocked" :controller="bindings.featureDiscovery" :language="language" :can-remind="hasBeenReady && bindings.taskIndex.tasks.value.every(task => task.activity === 'idle')" />
  </div>
</template>

<style scoped lang="scss">
.desktop-shell {
  width: 100dvw;
  height: 100dvh;
}

.desktop-shell__body,
.desktop-shell__content,
.desktop-shell__workbench {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
}
.desktop-shell__content {
  transition: opacity 220ms ease;
}

.desktop-shell__content.is-starting {
  opacity: 0;
}

.desktop-startup-reveal-leave-active {
  transition: opacity 220ms ease;
}

.desktop-startup-reveal-leave-to {
  opacity: 0;
}

.desktop-shell__workbench {
  background: var(--buddy-surface-canvas);
}

.desktop-app-sidebar-enter-active,
.desktop-app-sidebar-leave-active {
  transition:
    width 140ms cubic-bezier(0.4, 0, 0.2, 1),
    opacity 100ms ease;
  will-change: width, opacity;
}

.desktop-app-sidebar-enter-from,
.desktop-app-sidebar-leave-to {
  width: 0;
  border-right-color: transparent;
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .desktop-shell__content,
  .desktop-startup-reveal-leave-active,
  .desktop-app-sidebar-enter-active,
  .desktop-app-sidebar-leave-active {
    transition: none;
  }
}
</style>
