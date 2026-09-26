<script setup lang="ts">
import type { ExtensionReview, ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import { ChevronDown16Regular, MoreHorizontal20Regular, Wand20Regular } from '@vicons/fluent'
import { NAlert, NButton, NDropdown, NEmpty, NModal, useDialog, useMessage } from 'naive-ui'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useWorkbench } from '@/workbench/browser/workbenchContext'
import { useExtensionContext } from '../extensionContext'
import { extensionLabels } from '../extensionLabels'
import DesktopExtensionWorkbench from '../layouts/DesktopExtensionWorkbench.vue'
import { extensionErrorCode } from '../state/useExtensionState'
import DesktopExtensionCard from './DesktopExtensionCard.vue'
import DesktopExtensionCatalog from './DesktopExtensionCatalog.vue'
import DesktopExtensionInstallations from './DesktopExtensionInstallations.vue'
import DesktopExtensionInstallReview from './DesktopExtensionInstallReview.vue'
import DesktopExtensionUiSettings from './DesktopExtensionUiSettings.vue'

const { state, language, workbench, startCreation } = useExtensionContext()
const { controller } = useWorkbench()
const { installed } = state
const labels = computed(() => extensionLabels(language.value))
const section = shallowRef<'marketplace' | 'installed'>('installed')
const toolbarActions = computed(() => [{ key: 'history', label: language.value === 'en-US' ? 'Installation log' : '安装记录', props: { 'role': 'menuitem', 'data-testid': 'extension-installation-history' } }])
const acquisitionActions = computed(() => [
  { key: 'package', label: labels.value.install, props: { 'role': 'menuitem', 'data-testid': 'extension-install' } },
  { key: 'development', label: labels.value.development, props: { 'role': 'menuitem', 'data-testid': 'extension-development' } },
])
const acquisitionMenuOpen = shallowRef(false)
const busy = shallowRef(false)
const review = shallowRef<ExtensionReview | null>(null)
const diagnostics = shallowRef<string | null>(null)
const installationLog = shallowRef(false)
const dialog = useDialog()
const message = useMessage()
const router = useRouter()
const selected = computed(() => installed.value.find(item => item.manifest.id === diagnostics.value))
function showError(code: string) {
  message.error(`${labels.value.installFailed}: ${code}`)
}
watch(state.error, (error) => {
  if (error)
    showError(error)
}, { immediate: true })
async function run(action: () => Promise<unknown>) {
  if (busy.value)
    return
  busy.value = true
  try {
    await action()
    await state.refresh()
  }
  catch (reason) {
    if (reason instanceof Error && reason.message === 'SKILL_UNAVAILABLE')
      message.error(labels.value.creatorUnavailable)
    else
      showError(extensionErrorCode(reason))
  }
  finally {
    busy.value = false
  }
}
function select(development = false) {
  void run(async () => {
    review.value = await state.api.selectPackage(development)
  })
}
function create() {
  void run(() => startCreation(labels.value.creationPrompt))
}
function cancel() {
  const current = review.value
  review.value = null
  if (current)
    void state.api.cancelInstall(current.token).catch(() => {})
}
function install() {
  const current = review.value
  if (current) {
    void run(async () => {
      review.value = null
      await state.api.install(current.token)
      section.value = 'installed'
    })
  }
}
function remove(item: ExtensionStatus) {
  dialog.warning({ title: labels.value.removeTitle, content: `${item.manifest.name} · ${labels.value.retained}`, positiveText: labels.value.remove, negativeText: labels.value.cancel, positiveButtonProps: { type: 'error' }, onPositiveClick: () => run(() => state.api.uninstall(item.manifest.id)) })
}
onScopeDispose(cancel)
</script>

<template>
  <DesktopExtensionWorkbench v-model:section="section" :language="language" data-testid="extension-manager">
    <template #actions>
      <NDropdown trigger="click" :options="toolbarActions" @select="installationLog = true">
        <NButton quaternary size="small" class="extension-manager__more" :aria-label="labels.more" data-testid="extension-toolbar-more">
          <template #icon>
            <DesktopIcon :component="MoreHorizontal20Regular" :size="16" />
          </template>
        </NButton>
      </NDropdown>
      <div class="extension-manager__acquisition-split">
        <NButton class="extension-manager__create-button" type="primary" size="small" :disabled="busy" data-testid="extension-create" @click="create">
          <template #icon>
            <DesktopIcon :component="Wand20Regular" :size="16" />
          </template>
          {{ labels.create }}
        </NButton>
        <NDropdown v-model:show="acquisitionMenuOpen" trigger="click" placement="bottom-end" :options="acquisitionActions" :disabled="busy" @select="key => select(key === 'development')">
          <NButton class="extension-manager__acquisition-arrow" type="primary" size="small" :disabled="busy" :aria-label="labels.acquisitionOptions" aria-haspopup="menu" :aria-expanded="acquisitionMenuOpen" data-testid="extension-install-options">
            <template #icon>
              <DesktopIcon :component="ChevronDown16Regular" :size="16" class="extension-manager__acquisition-chevron" :class="{ 'is-open': acquisitionMenuOpen }" />
            </template>
          </NButton>
        </NDropdown>
      </div>
    </template>
    <NAlert v-if="state.installations.value.some(job => job.status === 'running')" type="info">
      {{ language === 'en-US' ? 'Installing plugin. You can continue using Lexora.' : '正在安装插件，你可以继续使用 Lexora。' }}
      <NButton text @click="installationLog = true">
        {{ language === 'en-US' ? 'View progress' : '查看进度' }}
      </NButton>
    </NAlert>
    <DesktopExtensionCatalog v-if="section === 'marketplace'" :busy="busy" @install="entry => run(async () => { review = await state.api.reviewCatalog(entry.manifest.id, entry.manifest.version) })" />
    <NEmpty v-else-if="!installed.length && !state.error.value" class="extension-manager__empty">
      <template #default>
        <strong>{{ labels.empty }}</strong>
        <p>{{ labels.emptyDescription }}</p>
        <NButton type="primary" :disabled="busy" @click="create">
          {{ labels.create }}
        </NButton>
      </template>
    </NEmpty>
    <div v-else-if="section === 'installed' && installed.length" class="extension-manager__grid">
      <DesktopExtensionCard
        v-for="item in installed"
        :key="item.manifest.id"
        :item="item"
        :context="workbench.values"
        :language="language"
        :busy="busy"
        @toggle="run(() => state.api.enable(item.manifest.id, !item.enabled))"
        @restart="run(() => state.api.restart(item.manifest.id))"
        @diagnostics="diagnostics = item.manifest.id"
        @remove="remove(item)"
        @open="router.push(desktopRouteLocations.extensionPage(item.manifest.id))"
        @command="id => run(() => controller.registry.execute(id, controller.context))"
        @revoke-resources="run(() => state.api.revokeResources(item.manifest.id))"
      />
    </div>
    <DesktopExtensionUiSettings v-if="section === 'installed'" :language="language" />
  </DesktopExtensionWorkbench>
  <NModal v-model:show="installationLog" preset="card" :title="language === 'en-US' ? 'Installation log' : '安装记录'" class="extension-dialog">
    <DesktopExtensionInstallations :jobs="state.installations.value" :language="language" @cancel="id => state.api.cancelInstallation(id).then(state.refresh)" />
  </NModal>
  <DesktopExtensionInstallReview v-if="review" :review="review" :language="language" :busy="busy" @cancel="cancel" @install="install" />
  <NModal :show="!!selected" preset="card" :title="labels.diagnostics" class="extension-dialog" @update:show="value => { if (!value) diagnostics = null }">
    <template v-if="selected">
      <h2>{{ selected.manifest.name }}</h2>
      <p>{{ labels.version }} {{ selected.manifest.version }} · API {{ selected.manifest.apiVersion }}</p>
      <p v-if="selected.activationMs !== null">
        {{ labels.activation }} {{ selected.activationMs }} ms
      </p>
      <p v-if="!selected.logs.length">
        {{ labels.noLogs }}
      </p>
      <ol class="extension-dialog__logs">
        <li v-for="(entry, index) in selected.logs" :key="index">
          <time>{{ new Date(entry.time).toLocaleTimeString() }}</time> <code>{{ entry.event }} {{ entry.code }} {{ entry.durationMs !== undefined ? `${entry.durationMs} ms` : '' }}</code>
        </li>
      </ol>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.extension-manager__more { width: 28px; height: 28px; padding: 0; }
.extension-manager__acquisition-split { display: inline-flex; align-items: stretch; }
.extension-manager__create-button { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.extension-manager__acquisition-arrow { width: 28px; margin-left: 1px; padding: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; }
.extension-manager__acquisition-chevron { transition: transform 140ms ease; }
.extension-manager__acquisition-chevron.is-open { transform: rotate(180deg); }
@media (prefers-reduced-motion: reduce) { .extension-manager__acquisition-chevron { transition: none; } }
.extension-manager__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); align-items: stretch; gap: 12px; }
.extension-manager__empty {
  min-height: 360px;
  margin: 0;
  padding-top: clamp(72px, 14vh, 132px);

  :deep(.n-empty__description) { display: grid; max-width: 420px; justify-items: center; gap: 10px; text-align: center; }
  strong { color: var(--buddy-text-strong); font-size: 16px; }
  p { margin: 0 0 6px; line-height: 1.6; }
}
.extension-dialog__logs { padding-left: 20px; max-height: 320px; overflow: auto; font-size: 12px; line-height: 1.8; }
:global(.extension-dialog) { width: min(560px, calc(100vw - 48px)); max-height: calc(100vh - 48px); overflow-y: auto; }
</style>
