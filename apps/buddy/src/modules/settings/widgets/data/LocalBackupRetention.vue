<script setup lang="ts">
import { DEFAULT_LOCAL_BACKUP_LIMIT } from '@buddy-shared/storage/backupRetention'
import { NInputNumber, NModal, useMessage } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { useSettingsContext } from '../../settingsContext'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'

const { applicationSettings, storage } = useSettingsContext()
const english = computed(() => applicationSettings.language.value === 'en-US')
const text = (zh: string, en: string) => english.value ? en : zh
const message = useMessage()
const limit = computed(() => applicationSettings.config.value?.desktop.localBackupLimit ?? DEFAULT_LOCAL_BACKUP_LIMIT)
const showCleanup = shallowRef(false)
const cleanupTitleId = useId()
const cleanupTitle = computed(() => text('是否立即清理旧备份？', 'Clean up older backups now?'))
const { pending, save } = useSettingMutation<'localBackupLimit'>(
  patch => applicationSettings.updateSettings(patch),
  () => message.error(text('设置保存失败，请重试。', 'Could not save the setting. Please retry.')),
)

async function updateLimit(value: number | null) {
  if (value === null || value === limit.value)
    return
  const previous = limit.value
  if (!await save('localBackupLimit', { desktop: { localBackupLimit: value } }))
    return
  if (value < previous) {
    if (storage.catalog.value.snapshots.length > value)
      showCleanup.value = true
    else
      message.success(text('保留数量已更新，下次备份时生效。', 'Limit saved. It will apply to the next backup.'))
  }
}

async function cleanup() {
  try {
    await storage.run(() => window.lexoraDesktop!.storage.prune())
    message.success(text('本地备份已清理，待上传或恢复的副本已保留。', 'Local backups cleaned up. Pending uploads and restores are retained.'))
    showCleanup.value = false
  }
  catch {
    message.error(text('旧备份未能全部清理，将在下次备份时重试。', 'Some older backups could not be removed. Cleanup will retry with the next backup.'))
    return false
  }
}
</script>

<template>
  <DesktopSettingRow v-slot="{ controlAttrs }" :label="text('本地备份保留数量', 'Local backup limit')" :description="text('下次成功备份后清理超额副本。待上传或恢复的副本暂时保留，云端和导出副本不受影响。', 'Older copies are removed after the next successful backup. Pending uploads and restores are retained. Cloud backups and exported copies are kept.')" toggle>
    <NInputNumber class="w-28 shrink-0" :input-props="{ ...controlAttrs, 'role': 'spinbutton', 'aria-valuemin': 1, 'aria-valuemax': 10, 'aria-valuenow': limit }" :value="limit" :min="1" :max="10" :precision="0" :update-value-on-input="false" :disabled="storage.busy.value || !!storage.summary.value?.pending || pending.has('localBackupLimit')" @update:value="updateLimit" />
  </DesktopSettingRow>
  <NModal v-model:show="showCleanup" preset="dialog" type="warning" :title="cleanupTitle" :aria-labelledby="cleanupTitleId" :content="text(`保留数量已调整为 ${limit} 份，现有备份尚未删除。下次成功备份后会自动清理，也可以现在处理。`, `The limit is now ${limit}. Existing backups have not been deleted. Older copies will be removed after the next successful backup, or you can clean them up now.`)" :positive-text="text('立即清理', 'Clean up now')" :negative-text="text('下次备份时处理', 'With next backup')" :closable="!storage.busy.value" :mask-closable="!storage.busy.value" :close-on-esc="!storage.busy.value" :positive-button-props="{ loading: storage.busy.value, disabled: storage.busy.value }" :negative-button-props="{ disabled: storage.busy.value }" @positive-click="cleanup">
    <template #header>
      <span :id="cleanupTitleId">{{ cleanupTitle }}</span>
    </template>
  </NModal>
</template>
