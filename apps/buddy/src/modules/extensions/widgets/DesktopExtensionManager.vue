<script setup lang="ts">
import type { ExtensionReview, ExtensionReviewResult, ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionIncompatibleReview } from '@buddy-shared/extensions/extensionCompatibility'
import type { FileOpeningChoice } from '@buddy-shared/files/fileOpening'
import { ChevronDown16Regular, MoreHorizontal20Regular, Wand20Regular } from '@vicons/fluent'
import { NButton, NDropdown, NEmpty, NModal, useMessage } from 'naive-ui'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useExtensionContext } from '../extensionContext'
import { extensionLabels } from '../extensionLabels'
import DesktopExtensionWorkbench from '../layouts/DesktopExtensionWorkbench.vue'
import { useExtensionRemoval } from '../state/useExtensionRemoval'
import { extensionErrorCode } from '../state/useExtensionState'
import DesktopExtensionAuthoringSettings from './DesktopExtensionAuthoringSettings.vue'
import DesktopExtensionCard from './DesktopExtensionCard.vue'
import DesktopExtensionCatalog from './DesktopExtensionCatalog.vue'
import DesktopExtensionIncompatibleReview from './DesktopExtensionIncompatibleReview.vue'
import DesktopExtensionInstallations from './DesktopExtensionInstallations.vue'
import DesktopExtensionInstallingCard from './DesktopExtensionInstallingCard.vue'
import DesktopExtensionInstallReview from './DesktopExtensionInstallReview.vue'
import DesktopExtensionUnavailableCard from './DesktopExtensionUnavailableCard.vue'
import DesktopExtensionUninstallDialog from './DesktopExtensionUninstallDialog.vue'

const { state, language, startCreation, authoring, settingsLocation } = useExtensionContext()
const { installed, unavailable } = state
const unavailableCurrent = computed(() => unavailable.value.filter(item => !item.pending))
const unavailablePending = computed(() => new Map(unavailable.value.filter(item => item.pending).map(item => [item.manifest.id, item])))
const labels = computed(() => extensionLabels(language.value))
const section = shallowRef<'marketplace' | 'installed'>('installed')
const toolbarActions = computed(() => [{ key: 'author', label: language.value === 'en-US' ? 'Author signature' : '作者署名', props: { 'role': 'menuitem', 'data-testid': 'extension-author-settings' } }, { key: 'history', label: language.value === 'en-US' ? 'Installation log' : '安装记录', props: { 'role': 'menuitem', 'data-testid': 'extension-installation-history' } }])
const acquisitionActions = computed(() => [
  { key: 'package', label: labels.value.install, props: { 'role': 'menuitem', 'data-testid': 'extension-install' } },
  { key: 'development', label: labels.value.development, props: { 'role': 'menuitem', 'data-testid': 'extension-development' } },
])
const acquisitionMenuOpen = shallowRef(false)
const selecting = shallowRef(false)
const creating = shallowRef(false)
const reviewQueue: ExtensionReviewResult[] = []
const jobs = computed(() => new Map(state.installations.value.map(job => [job.id, job])))
const newInstallations = computed(() => [...state.pendingInstalls.values()].filter(item => !installed.value.some(plugin => plugin.manifest.id === item.manifest.id)))
const review = shallowRef<ExtensionReview | null>(null)
const incompatibleReview = shallowRef<ExtensionIncompatibleReview | null>(null)
const diagnostics = shallowRef<string | null>(null)
const installationLog = shallowRef(false)
const authorSettings = shallowRef(false)
const { removing, removalImpact, askRemove, remove, cancel: cancelRemoval } = useExtensionRemoval({ api: state.api, run, isBusy: id => state.busyIds.has(id), dismissInstall: state.dismissInstall })
let disposed = false
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
async function run(action: () => Promise<unknown>, id?: string) {
  try {
    return (id ? await state.runOperation(id, action) : await action()) !== false
  }
  catch (reason) {
    if (reason instanceof Error && reason.message === 'SKILL_UNAVAILABLE')
      message.error(labels.value.creatorUnavailable)
    else
      showError(extensionErrorCode(reason))
    return false
  }
}
async function select(development = false) {
  if (selecting.value)
    return
  selecting.value = true
  try {
    await run(async () => acceptReview(await state.api.selectPackage(development)))
  }
  finally {
    selecting.value = false
  }
}
function acceptReview(next: ExtensionReviewResult | null) {
  if (!next)
    return
  if (disposed) {
    if ('token' in next)
      void state.api.cancelInstall(next.token).catch(() => {})
    return
  }
  reviewQueue.push(next)
  showNextReview()
}
function showNextReview() {
  if (disposed || review.value || incompatibleReview.value)
    return
  const next = reviewQueue.shift()
  incompatibleReview.value = next && 'incompatibility' in next ? next : null
  review.value = next && 'token' in next ? next : null
}
async function create() {
  if (creating.value)
    return
  creating.value = true
  try {
    await run(() => startCreation(labels.value.creationPrompt))
  }
  finally {
    creating.value = false
  }
}
function cancel() {
  const current = review.value
  review.value = null
  incompatibleReview.value = null
  if (current)
    void state.api.cancelInstall(current.token).catch(() => {})
  showNextReview()
}
function install(applyUpdate: boolean, choices: FileOpeningChoice[]) {
  const current = review.value
  if (current && !state.busyIds.has(current.manifest.id)) {
    review.value = null
    section.value = 'installed'
    void run(async () => {
      const installed = await state.install(current, applyUpdate, choices)
      if (installed && current.currentVersion)
        message.success(applyUpdate ? labels.value.updateApplied : labels.value.updateDeferred)
      return installed
    })
    showNextReview()
  }
}
function applyUpdate(id: string) {
  state.dismissInstall(id)
  void run(async () => {
    await state.api.applyUpdate(id)
    message.success(labels.value.updateApplied)
  }, id)
}
function openLocation(item: ExtensionStatus) {
  if (!item.enabled || !item.compatible || item.state === 'blocked')
    return null
  return item.manifest.contributes.navigation ? desktopRouteLocations.extensionPage(item.manifest.id) : settingsLocation(item.manifest.id)
}
function open(item: ExtensionStatus) {
  const location = openLocation(item)
  if (location)
    void router.push(location)
}
onScopeDispose(() => {
  disposed = true
  cancel()
  for (const next of reviewQueue.splice(0)) {
    if ('token' in next)
      void state.api.cancelInstall(next.token).catch(() => {})
  }
})
</script>

<template>
  <DesktopExtensionWorkbench v-model:section="section" :language="language" data-testid="extension-manager">
    <template #actions>
      <NDropdown trigger="click" :options="toolbarActions" @select="key => { if (key === 'author') authorSettings = true; else installationLog = true }">
        <NButton quaternary size="small" class="extension-manager__more" :aria-label="labels.more" data-testid="extension-toolbar-more">
          <template #icon>
            <DesktopIcon :component="MoreHorizontal20Regular" :size="16" />
          </template>
        </NButton>
      </NDropdown>
      <div class="inline-flex items-stretch">
        <NButton class="extension-manager__create-button" type="primary" size="small" :loading="creating" data-testid="extension-create" @click="create">
          <template #icon>
            <DesktopIcon :component="Wand20Regular" :size="16" />
          </template>
          {{ labels.create }}
        </NButton>
        <NDropdown v-model:show="acquisitionMenuOpen" trigger="click" placement="bottom-end" :options="acquisitionActions" :disabled="selecting" @select="key => select(key === 'development')">
          <NButton class="extension-manager__acquisition-arrow" type="primary" size="small" :loading="selecting" :aria-label="labels.acquisitionOptions" aria-haspopup="menu" :aria-expanded="acquisitionMenuOpen" data-testid="extension-install-options">
            <template #icon>
              <DesktopIcon :component="ChevronDown16Regular" :size="16" class="extension-manager__acquisition-chevron" :class="{ 'is-open': acquisitionMenuOpen }" />
            </template>
          </NButton>
        </NDropdown>
      </div>
    </template>
    <DesktopExtensionCatalog v-if="section === 'marketplace'" @install="entry => run(async () => { acceptReview(await state.api.reviewCatalog(entry.manifest.id, entry.manifest.version)) }, entry.manifest.id)" @apply-update="applyUpdate" />
    <NEmpty v-else-if="!installed.length && !unavailable.length && !newInstallations.length && !state.error.value" class="extension-manager__empty">
      <template #default>
        <strong>{{ labels.empty }}</strong>
        <p>{{ labels.emptyDescription }}</p>
        <NButton type="primary" :loading="creating" @click="create">
          {{ labels.create }}
        </NButton>
      </template>
    </NEmpty>
    <div v-else-if="section === 'installed' && (installed.length || unavailable.length || newInstallations.length)" class="grid grid-cols-[repeat(auto-fill,_minmax(min(100%,_280px),_1fr))] items-stretch gap-[12px]">
      <DesktopExtensionUnavailableCard v-for="item in unavailableCurrent" :key="item.manifest.id" :item="item" :language="language" />
      <DesktopExtensionCard
        v-for="item in installed"
        :key="item.manifest.id"
        :item="item"
        :unavailable-pending="unavailablePending.get(item.manifest.id)"
        :language="language"
        :busy="state.busyIds.has(item.manifest.id)"
        :installation="state.pendingInstalls.get(item.manifest.id)"
        :job="jobs.get(state.pendingInstalls.get(item.manifest.id)?.installationId ?? '')"
        :can-open="!!openLocation(item)"
        @progress="installationLog = true"
        @dismiss-install="state.dismissInstall(item.manifest.id)"
        @toggle="run(() => state.api.enable(item.manifest.id, !item.enabled), item.manifest.id)"
        @restart="run(() => state.api.restart(item.manifest.id), item.manifest.id)"
        @apply-update="applyUpdate(item.manifest.id)"
        @diagnostics="diagnostics = item.manifest.id"
        @remove="askRemove(item)"
        @open="open(item)"
        @revoke-resources="run(() => state.api.revokeResources(item.manifest.id), item.manifest.id)"
      />
      <DesktopExtensionInstallingCard
        v-for="item in newInstallations"
        :key="item.manifest.id"
        :installation="item"
        :job="jobs.get(item.installationId ?? '')"
        :language="language"
        @progress="installationLog = true"
        @dismiss="state.dismissInstall(item.manifest.id)"
      />
    </div>
  </DesktopExtensionWorkbench>
  <NModal v-model:show="authorSettings" preset="card" :title="language === 'en-US' ? 'Author signature' : '作者署名'" class="extension-dialog">
    <DesktopExtensionAuthoringSettings v-if="authorSettings" :author="authoring.author.value" :language="language" :save="authoring.save" @saved="authorSettings = false" />
  </NModal>
  <NModal v-model:show="installationLog" preset="card" :title="language === 'en-US' ? 'Installation log' : '安装记录'" class="extension-dialog">
    <DesktopExtensionInstallations :jobs="state.installations.value" :language="language" @cancel="id => state.api.cancelInstallation(id).then(state.refreshInstallations)" />
  </NModal>
  <DesktopExtensionInstallReview v-if="review" :key="review.token" :review="review" :language="language" :busy="state.busyIds.has(review.manifest.id)" @cancel="cancel" @install="install" />
  <DesktopExtensionIncompatibleReview v-if="incompatibleReview" :review="incompatibleReview" :language="language" @close="cancel" />
  <DesktopExtensionUninstallDialog v-if="removing && removalImpact" :name="removing.manifest.name" :impact="removalImpact" :language="language" :busy="state.busyIds.has(removing.manifest.id)" @cancel="cancelRemoval" @remove="remove" />
  <NModal :show="!!selected" preset="card" :title="labels.diagnostics" class="extension-dialog" @update:show="value => { if (!value) diagnostics = null }">
    <template v-if="selected">
      <h2>{{ selected.manifest.name }}</h2>
      <p>{{ selected.manifest.author || (language === 'en-US' ? 'Unsigned' : '未署名') }}</p>
      <p><code>{{ selected.manifest.id }}</code></p>
      <p>{{ selected.source ? (language === 'en-US' ? 'Marketplace' : '插件市场') : (language === 'en-US' ? 'Local installation' : '本地安装') }}</p>
      <p>{{ labels.version }} {{ selected.manifest.version }} · API {{ selected.manifest.apiVersion }}</p>
      <p v-if="selected.activationMs !== null">
        {{ labels.activation }} {{ selected.activationMs }} ms
      </p>
      <p v-if="!selected.logs.length">
        {{ labels.noLogs }}
      </p>
      <ol class="pl-[20px] max-h-[320px] overflow-auto text-[12px] leading-[1.8]">
        <li v-for="(entry, index) in selected.logs" :key="index">
          <time>{{ new Date(entry.time).toLocaleTimeString() }}</time> <code>{{ entry.event }} {{ entry.code }} {{ entry.durationMs !== undefined ? `${entry.durationMs} ms` : '' }}</code>
        </li>
      </ol>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.extension-manager__more { width: 28px; height: 28px; padding: 0; }

.extension-manager__create-button { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.extension-manager__acquisition-arrow { width: 28px; margin-left: 1px; padding: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; }
.extension-manager__acquisition-chevron { transition: transform 140ms ease; }
.extension-manager__acquisition-chevron.is-open { transform: rotate(180deg); }
@media (prefers-reduced-motion: reduce) { .extension-manager__acquisition-chevron { transition: none; } }

.extension-manager__empty {
  min-height: 360px;
  margin: 0;
  padding-top: clamp(72px, 14vh, 132px);

  :deep(.n-empty__description) { display: grid; max-width: 420px; justify-items: center; gap: 10px; text-align: center; }
  strong { color: var(--buddy-text-strong); font-size: 16px; }
  p { margin: 0 0 6px; line-height: 1.6; }
}

:global(.extension-dialog) { width: min(560px, calc(100vw - 48px)); max-height: calc(100vh - 48px); overflow-y: auto; }
</style>
