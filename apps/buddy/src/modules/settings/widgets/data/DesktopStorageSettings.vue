<script setup lang="ts">
import { NAlert, NButton, NSpin } from 'naive-ui'
import { computed, onMounted, shallowRef } from 'vue'
import DataStorageIcon from '@/shared/ui/icon/DataStorageIcon.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useSettingsContext } from '../../settingsContext'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import StorageUsage from './StorageUsage.vue'

const { applicationSettings, storageUsage, storage } = useSettingsContext()
const english = computed(() => applicationSettings.language.value === 'en-US')
const { summary, busy, loading } = storage
const error = shallowRef('')
const text = (zh: string, en: string) => english.value ? en : zh
const api = () => window.lexoraDesktop!.storage
async function perform(action: () => Promise<unknown>) {
  if (busy.value)
    return
  error.value = ''
  try {
    await storage.run(action)
  }
  catch (failure) {
    const detail = failure instanceof Error ? failure.message : ''
    error.value = detail.includes('SNAPSHOT_RUNTIME_BUSY') ? text('请等待任务完成后再创建备份。', 'Wait for running tasks to finish before creating a backup.') : detail.includes('STORAGE_TARGET_NOT_EMPTY') ? text('请选择空目录，或这份数据曾经使用的目录。', 'Choose an empty directory or a previous location of this data.') : detail.includes('STORAGE_PATH_OVERLAP') || detail.includes('STORAGE_PROTECTED_PATH') ? text('目标不能与当前目录或启动配置目录相互包含。', 'The target cannot overlap the current data or startup directory.') : text('操作未完成。数据仍保留在原位置，请检查目录权限和可用空间后重试。', 'The operation did not complete. Your original data is preserved. Check permissions and free space, then retry.')
  }
}
async function relocate(target?: string) {
  await perform(async () => {
    const selected = target ?? await api().choose()
    if (selected)
      await api().relocate(selected)
  })
}
onMounted(() => {
  void storage.ensureLoaded().catch(() => {
    error.value = text('部分存储信息暂时无法读取，请重新打开设置后重试。', 'Some storage information is unavailable. Reopen settings to retry.')
  })
  void storageUsage.ensureLoaded()
})
</script>

<template>
  <section class="grid gap-3 min-w-0" :aria-label="text('数据概览', 'Data overview')" :aria-busy="busy">
    <h2 class="m-0 flex items-center gap-2 text-[0.92rem] font-600">
      <DesktopIcon :component="DataStorageIcon" :size="18" class="text-muted" />
      {{ text('数据概览', 'Data overview') }}
    </h2>
    <NAlert v-if="error" type="error" :show-icon="false">
      {{ error }}
    </NAlert>
    <NSpin v-if="!summary && loading" />
    <DesktopSettingsGroup v-if="summary">
      <DesktopSettingRow :label="text('数据目录', 'Data directory')" toggle>
        <template #hint>
          <p class="m-0 font-mono text-[0.7rem] text-muted break-all" data-testid="storage-current-root">
            {{ summary.root }}
          </p>
        </template>
        <NButton :disabled="busy" @click="perform(() => api().open())">
          {{ text('打开目录', 'Open folder') }}
        </NButton>
        <NButton :disabled="busy || !!summary.pending" @click="relocate()">
          {{ text('更改目录', 'Change location') }}
        </NButton>
        <NButton v-if="summary.root !== summary.defaultRoot" quaternary :disabled="busy || !!summary.pending" @click="relocate(summary.defaultRoot)">
          {{ text('恢复默认位置', 'Use default location') }}
        </NButton>
      </DesktopSettingRow>
      <div v-if="summary.pending" class="p-[0.9rem] border-b border-b-solid border-border">
        <NAlert type="info" :show-icon="false" data-testid="storage-pending">
          <strong>{{ summary.pending.kind === 'restore' ? text('重启后恢复备份', 'Restore after restart') : text('重启后更改目录', 'Move after restart') }}</strong>
          <p class="font-mono break-all text-[0.8rem]">
            {{ summary.pending.target }}
          </p>
          <p>{{ text('原有数据会保留。', 'Your current data will be preserved.') }}</p>
          <div class="flex flex-wrap gap-2">
            <NButton type="primary" :disabled="busy" @click="perform(() => api().restart())">
              {{ summary.pending.kind === 'restore' ? text('重启并恢复', 'Restart and restore') : text('重启并搬迁', 'Restart and move') }}
            </NButton>
            <NButton :disabled="busy" @click="perform(() => api().cancel())">
              {{ text('取消', 'Cancel') }}
            </NButton>
          </div>
        </NAlert>
      </div>
      <StorageUsage :usage="storageUsage.usage.value" :loading="storageUsage.loading.value" :failed="storageUsage.failed.value" :english="english" @scan="storageUsage.refresh" />
    </DesktopSettingsGroup>
  </section>
</template>
