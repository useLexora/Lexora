<script setup lang="ts">
import type { ExtensionReview, ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import { ChevronDown16Regular, MoreHorizontal20Regular, Wand20Regular } from '@vicons/fluent'
import { NAlert, NButton, NDropdown, NEmpty, NModal, useMessage } from 'naive-ui'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useExtensionContext } from '../extensionContext'
import { extensionLabels } from '../extensionLabels'
import DesktopExtensionWorkbench from '../layouts/DesktopExtensionWorkbench.vue'
import { extensionErrorCode } from '../state/useExtensionState'
import DesktopExtensionAuthoringSettings from './DesktopExtensionAuthoringSettings.vue'
import DesktopExtensionCard from './DesktopExtensionCard.vue'
import DesktopExtensionCatalog from './DesktopExtensionCatalog.vue'
import DesktopExtensionInstallations from './DesktopExtensionInstallations.vue'
import DesktopExtensionInstallReview from './DesktopExtensionInstallReview.vue'
import DesktopExtensionUninstallDialog from './DesktopExtensionUninstallDialog.vue'

const { state, language, startCreation, authoring, settingsLocation } = useExtensionContext()
const { installed } = state
const labels = computed(() => extensionLabels(language.value))
const section = shallowRef<'marketplace' | 'installed'>('installed')
const toolbarActions = computed(() => [{ key: 'author', label: language.value === 'en-US' ? 'Author signature' : '作者署名', props: { 'role': 'menuitem', 'data-testid': 'extension-author-settings' } }, { key: 'history', label: language.value === 'en-US' ? 'Installation log' : '安装记录', props: { 'role': 'menuitem', 'data-testid': 'extension-installation-history' } }])
const acquisitionActions = computed(() => [
  { key: 'package', label: labels.value.install, props: { 'role': 'menuitem', 'data-testid': 'extension-install' } },
  { key: 'development', label: labels.value.development, props: { 'role': 'menuitem', 'data-testid': 'extension-development' } },
])
const acquisitionMenuOpen = shallowRef(false)
const busy = shallowRef(false)
const review = shallowRef<ExtensionReview | null>(null)
const diagnostics = shallowRef<string | null>(null)
const installationLog = shallowRef(false)
const authorSettings = shallowRef(false)
const removing = shallowRef<ExtensionStatus | null>(null)
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
    return false
  busy.value = true
  try {
    await action()
    await state.refresh()
    return true
  }
  catch (reason) {
    if (reason instanceof Error && reason.message === 'SKILL_UNAVAILABLE')
      message.error(labels.value.creatorUnavailable)
    else
      showError(extensionErrorCode(reason))
    return false
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
function install(applyUpdate: boolean) {
  const current = review.value
  if (current) {
    void run(async () => {
      review.value = null
      await state.install(current, applyUpdate)
      section.value = 'installed'
      if (current.currentVersion)
        message.success(applyUpdate ? labels.value.updateApplied : labels.value.updateDeferred)
    })
  }
}
function applyUpdate(id: string) {
  void run(async () => {
    await state.api.applyUpdate(id)
    message.success(labels.value.updateApplied)
  })
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
async function remove(clearData: boolean) {
  const item = removing.value
  if (item && await run(() => state.api.uninstall(item.manifest.id, { clearData })))
    removing.value = null
}
onScopeDispose(cancel)
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
    <DesktopExtensionCatalog v-if="section === 'marketplace'" :busy="busy" @install="entry => run(async () => { review = await state.api.reviewCatalog(entry.manifest.id, entry.manifest.version) })" @apply-update="applyUpdate" />
    <NEmpty v-else-if="!installed.length && !state.error.value" class="extension-manager__empty">
      <template #default>
        <strong>{{ labels.empty }}</strong>
        <p>{{ labels.emptyDescription }}</p>
        <NButton type="primary" :disabled="busy" @click="create">
          {{ labels.create }}
        </NButton>
      </template>
    </NEmpty>
    <div v-else-if="section === 'installed' && installed.length" class="grid grid-cols-[repeat(auto-fill,_minmax(min(100%,_280px),_1fr))] items-stretch gap-[12px]">
      <DesktopExtensionCard
        v-for="item in installed"
        :key="item.manifest.id"
        :item="item"
        :language="language"
        :busy="busy"
        :can-open="!!openLocation(item)"
        @toggle="run(() => state.api.enable(item.manifest.id, !item.enabled))"
        @restart="run(() => state.api.restart(item.manifest.id))"
        @apply-update="applyUpdate(item.manifest.id)"
        @diagnostics="diagnostics = item.manifest.id"
        @remove="removing = item"
        @open="open(item)"
        @revoke-resources="run(() => state.api.revokeResources(item.manifest.id))"
      />
    </div>
  </DesktopExtensionWorkbench>
  <NModal v-model:show="authorSettings" preset="card" :title="language === 'en-US' ? 'Author signature' : '作者署名'" class="extension-dialog">
    <DesktopExtensionAuthoringSettings v-if="authorSettings" :author="authoring.author.value" :language="language" :save="authoring.save" @saved="authorSettings = false" />
  </NModal>
  <NModal v-model:show="installationLog" preset="card" :title="language === 'en-US' ? 'Installation log' : '安装记录'" class="extension-dialog">
    <DesktopExtensionInstallations :jobs="state.installations.value" :language="language" @cancel="id => state.api.cancelInstallation(id).then(state.refresh)" />
  </NModal>
  <DesktopExtensionInstallReview v-if="review" :key="review.token" :review="review" :language="language" :busy="busy" @cancel="cancel" @install="install" />
  <DesktopExtensionUninstallDialog v-if="removing" :name="removing.manifest.name" :language="language" :busy="busy" @cancel="removing = null" @remove="remove" />
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
