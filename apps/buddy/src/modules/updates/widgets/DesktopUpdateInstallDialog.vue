<script setup lang="ts">
import type { DesktopUpdateManualInstallation } from '@buddy-electron/shared/desktopUpdates'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Checkmark20Regular, Copy20Regular, FolderOpen20Regular } from '@vicons/fluent'
import { NButton, NModal, NScrollbar } from 'naive-ui'
import { shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  show: boolean
  installation: DesktopUpdateManualInstallation
  language: BuddyLocale
  failed: boolean
  pending: boolean
  writeClipboardText: (text: string) => Promise<void>
}>()
const emit = defineEmits<{
  'update:show': [show: boolean]
  'openDirectory': []
  'quit': []
}>()
const { t } = useBuddyI18n(() => props.language)
const copied = shallowRef(false)
const copying = shallowRef(false)
const copyFailed = shallowRef(false)
watch([() => props.show, () => props.installation.command], () => {
  copied.value = false
  copyFailed.value = false
})

async function copyCommand() {
  copying.value = true
  copyFailed.value = false
  try {
    await props.writeClipboardText(props.installation.command)
    copied.value = true
  }
  catch {
    copyFailed.value = true
  }
  finally {
    copying.value = false
  }
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="desktop-update-install-dialog"
    :style="{ width: 'min(40rem, calc(100vw - 2rem))', maxHeight: 'calc(100vh - 2rem)' }"
    content-class="min-h-0 flex flex-col"
    :title="t('desktop.update.installStepsTitle')"
    @update:show="emit('update:show', $event)"
  >
    <NScrollbar class="min-h-0" style="max-height: calc(100vh - 12rem)">
      <div class="min-w-0 pr-[4px]">
        <header class="pb-[20px]">
          <h2 class="m-0 text-[18px] leading-[1.4] text-strong font-600">
            Lexora Buddy {{ installation.version }}
          </h2>
          <p class="mt-[6px] mb-0 text-muted text-[13px] leading-[1.7]">
            {{ t(failed ? 'desktop.update.installStepsFailed' : 'desktop.update.installStepsDescription', { manager: installation.manager }) }}
          </p>
        </header>

        <ol class="m-0 p-0 list-none grid gap-[22px]">
          <li class="grid grid-cols-[24px_minmax(0,1fr)] gap-[12px]">
            <span class="flex items-center justify-center h-[24px] rounded-[6px] bg-accent-surface text-accent-text text-[12px] font-600" aria-hidden="true">1</span>
            <div class="min-w-0">
              <h3 class="m-0 text-[14px] leading-[24px] text-strong font-600">
                {{ t('desktop.update.copyInstallCommand') }}
              </h3>
              <div class="mt-[10px] overflow-hidden rounded-[8px] border border-solid border-code-border bg-code text-code-fg">
                <div class="flex items-center justify-between gap-2 px-[12px] py-[6px] bg-code-header border-0 border-b border-solid border-code-border">
                  <span class="text-[12px] text-muted">{{ t('desktop.update.terminalCommand') }}</span>
                  <NButton size="tiny" quaternary :loading="copying" @click="copyCommand">
                    <template #icon>
                      <DesktopIcon :component="copied ? Checkmark20Regular : Copy20Regular" :size="16" />
                    </template>
                    {{ t(copied ? 'desktop.update.commandCopied' : 'desktop.update.copyCommand') }}
                  </NButton>
                </div>
                <pre class="m-0 p-[14px] font-mono text-[12px] leading-[1.8] whitespace-pre-wrap [overflow-wrap:anywhere] select-text"><code>{{ installation.command }}</code></pre>
              </div>
              <p v-if="copyFailed" class="mt-2 mb-0 text-danger text-[12px]" role="alert">
                {{ t('desktop.update.copyCommandFailed') }}
              </p>
              <p v-else-if="copied" class="mt-2 mb-0 text-success text-[12px]" role="status">
                {{ t('desktop.update.commandCopiedDescription') }}
              </p>
            </div>
          </li>
          <li class="grid grid-cols-[24px_minmax(0,1fr)] gap-[12px]">
            <span class="flex items-center justify-center h-[24px] rounded-[6px] bg-subtle text-muted text-[12px] font-600" aria-hidden="true">2</span>
            <div>
              <h3 class="m-0 text-[14px] leading-[24px] text-strong font-600">
                {{ t('desktop.update.runInstallCommand') }}
              </h3>
              <p class="mt-[4px] mb-0 text-muted text-[13px] leading-[1.7]">
                {{ t('desktop.update.runInstallCommandDescription') }}
              </p>
            </div>
          </li>
          <li class="grid grid-cols-[24px_minmax(0,1fr)] gap-[12px]">
            <span class="flex items-center justify-center h-[24px] rounded-[6px] bg-subtle text-muted text-[12px] font-600" aria-hidden="true">3</span>
            <div>
              <h3 class="m-0 text-[14px] leading-[24px] text-strong font-600">
                {{ t('desktop.update.reopenAfterInstall') }}
              </h3>
              <p class="mt-[4px] mb-0 text-muted text-[13px] leading-[1.7]">
                {{ t('desktop.update.reopenAfterInstallDescription') }}
              </p>
            </div>
          </li>
        </ol>

        <div class="mt-[24px] pt-[16px] border-0 border-t border-solid border-border">
          <div class="flex items-center justify-between flex-wrap gap-[8px]">
            <span class="text-[12px] text-muted">{{ t('desktop.update.downloadedPackage') }}</span>
            <NButton text size="tiny" :disabled="pending" @click="emit('openDirectory')">
              <template #icon>
                <DesktopIcon :component="FolderOpen20Regular" :size="16" />
              </template>
              {{ t('desktop.update.openDownloadDirectory') }}
            </NButton>
          </div>
          <p class="mt-[8px] mb-0 font-mono text-[12px] leading-[1.7] text-fg [overflow-wrap:anywhere] select-text">
            {{ installation.packageName }}
          </p>
          <p class="mt-[2px] mb-0 font-mono text-[11px] leading-[1.7] text-muted [overflow-wrap:anywhere] select-text">
            {{ installation.packagePath.slice(0, -installation.packageName.length) }}
          </p>
        </div>
      </div>
    </NScrollbar>
    <template #footer>
      <div class="flex flex-wrap justify-between items-center gap-[12px]">
        <NButton :disabled="pending" @click="emit('update:show', false)">
          {{ t('desktop.update.backToUpdate') }}
        </NButton>
        <NButton type="primary" :disabled="pending" @click="emit('quit')">
          {{ t('desktop.update.quitForManualInstall') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>
