<script setup lang="ts">
import type { BackupOptions } from '@buddy-shared/storage/backupScope'
import type { SnapshotSummary } from '@buddy-shared/storage/snapshot'
import { NAlert, NButton, NModal, NScrollbar, useMessage } from 'naive-ui'
import { computed, onMounted, shallowRef } from 'vue'
import { useSettingsContext } from '../../settingsContext'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import BackupSelectionDialog from './BackupSelectionDialog.vue'
import DataSnapshotList from './DataSnapshotList.vue'

const { applicationSettings, storage } = useSettingsContext()
const english = computed(() => applicationSettings.language.value === 'en-US')
const text = (zh: string, en: string) => english.value ? en : zh
const api = () => window.lexoraDesktop!.storage
const { catalog, summary, progress, busy } = storage
const showBackups = shallowRef(false)
const showSelection = shallowRef(false)
const selected = shallowRef<SnapshotSummary | null>(null)
const error = shallowRef('')
const message = useMessage()
async function perform(action: () => Promise<unknown>) {
  if (busy.value)
    return
  error.value = ''
  try {
    await storage.run(action)
  }
  catch (failure) {
    const detail = failure instanceof Error ? failure.message : ''
    error.value = detail.includes('SNAPSHOT_IN_USE') ? text('这份备份正在等待上传或恢复，暂时无法删除。', 'This backup is pending upload or restore and cannot be deleted yet.') : detail.includes('CREDENTIAL_STORE') ? text('本机安全存储暂不可用，可取消「包含密钥」后备份。', 'Secure storage is unavailable. You can back up without credentials.') : detail.includes('PASSWORD_INVALID') ? text('备份口令不正确，或加密数据已损坏。', 'The password is incorrect or the encrypted data is damaged.') : detail.includes('RUNTIME_BUSY') ? text('请等待当前任务完成后再备份。', 'Wait for current tasks to finish before creating a backup.') : detail.includes('STORAGE_OPERATION_PENDING') ? text('请先完成或取消待处理的目录操作。', 'Complete or cancel the pending storage operation first.') : text('操作未完成，原有数据已保留。请检查备份文件、目录权限和可用空间。', 'The operation failed. Original data is preserved. Check the backup files, permissions and free space.')
  }
}
function create() {
  selected.value = null
  error.value = ''
  showSelection.value = true
}
function restore(id: string) {
  selected.value = catalog.value.snapshots.find(item => item.id === id) ?? null
  error.value = ''
  showBackups.value = false
  showSelection.value = !!selected.value
}
async function confirm(options: BackupOptions) {
  await perform(async () => {
    if (selected.value) {
      await api().restore(selected.value.id, options)
      await api().restart()
    }
    else {
      await api().snapshot(options)
      showSelection.value = false
      message.success(text('备份已创建', 'Backup created'))
    }
  })
}
async function deleteBackup(id: string) {
  await perform(async () => {
    await api().delete(id)
    message.success(text('本地备份已删除', 'Local backup deleted'))
  })
}
async function importBackup() {
  await perform(async () => {
    const imported = await api().import()
    if (!imported)
      return
    selected.value = imported
    showBackups.value = false
    showSelection.value = true
  })
}
async function exportBackup(id: string) {
  await perform(async () => {
    if (await api().export(id))
      message.success(text('备份已导出到所选目录', 'Backup exported to the selected folder'))
  })
}
onMounted(() => {
  void storage.ensureLoaded().catch(() => {
    error.value = text('备份列表暂时无法读取，请重新打开设置后重试。', 'Backups are unavailable. Reopen settings to retry.')
  })
})
</script>

<template>
  <DesktopSettingsGroup>
    <DesktopSettingRow :label="text('本地备份', 'Local backups')" toggle>
      <template #hint>
        <small v-if="busy && progress" role="status" class="text-muted text-[0.7rem]">{{ text('正在处理备份…', 'Processing backup…') }} {{ progress.totalBytes ? `${Math.floor(progress.completedBytes / progress.totalBytes * 100)}%` : '' }}</small>
        <small v-else-if="catalog.snapshots.length" class="text-muted text-[0.7rem]">{{ text('最近备份', 'Latest backup') }} · {{ new Date(catalog.snapshots[0]!.createdAt).toLocaleString(english ? 'en-US' : 'zh-CN') }}</small>
      </template>
      <NButton :disabled="busy" @click="showBackups = true">
        {{ text('查看备份', 'View backups') }}<span v-if="catalog.snapshots.length" class="ml-1">({{ catalog.snapshots.length }})</span>
      </NButton>
      <NButton :disabled="busy || !!summary?.pending" @click="importBackup">
        {{ text('导入备份', 'Import backup') }}
      </NButton>
      <NButton type="primary" :disabled="busy || !!summary?.pending" @click="create">
        {{ text('创建备份', 'Create backup') }}
      </NButton>
    </DesktopSettingRow>
    <NAlert v-if="error && !showSelection && !showBackups" type="error" :show-icon="false" class="m-3">
      {{ error }}
    </NAlert>
  </DesktopSettingsGroup>
  <NModal v-model:show="showBackups" preset="card" :title="text('本地备份', 'Local backups')" :style="{ width: 'min(760px, calc(100vw - 32px))' }">
    <div class="grid gap-3">
      <NAlert v-if="error" type="error" :show-icon="false">
        {{ error }}
      </NAlert>
      <NScrollbar :style="{ maxHeight: 'min(65vh, 32rem)' }">
        <DataSnapshotList :catalog="catalog" :disabled="busy || !!summary?.pending" :english="english" @select="restore" @export="exportBackup" @delete="deleteBackup" />
      </NScrollbar>
    </div>
  </NModal>
  <BackupSelectionDialog v-model:show="showSelection" :snapshot="selected" :root="summary?.root" :english="english" :busy="busy" :error="error" @confirm="confirm" />
</template>
