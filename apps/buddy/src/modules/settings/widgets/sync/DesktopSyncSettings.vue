<script setup lang="ts">
import type { BackupOptions } from '@buddy-shared/storage/backupScope'
import type { SyncConnectionInput, SyncState } from '@buddy-shared/sync/syncApi'
import { NSwitch, useMessage } from 'naive-ui'
import { computed, onMounted, onUnmounted, shallowRef, useId, watch } from 'vue'
import CloudBackupIcon from '@/shared/ui/icon/CloudBackupIcon.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopSegmentedControl from '@/shared/ui/segmented-control/DesktopSegmentedControl.vue'
import { useSettingsContext } from '../../settingsContext'
import BackupSelectionDialog from '../data/BackupSelectionDialog.vue'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import SyncConnectionForm from './SyncConnectionForm.vue'

const { applicationSettings, cloudBackup } = useSettingsContext()
const english = computed(() => applicationSettings.language.value === 'en-US')
const text = (zh: string, en: string) => english.value ? en : zh
const message = useMessage()
const state = shallowRef<SyncState>({ enabled: false, selectedAdapter: 'webdav', activeConnectionId: null, connections: [], activity: null, schedules: [], scheduleError: false })
const connectionFormId = useId()
const formRevision = shallowRef(0)
const loaded = shallowRef(false)
const busy = shallowRef(false)
const showSelection = shallowRef(false)
const pendingConnection = shallowRef<SyncConnectionInput>()
const initialFrequency = shallowRef<'hourly' | 'daily' | 'weekly'>('daily')
const error = shallowRef('')
const active = computed(() => state.value.connections.find(item => item.id === state.value.activeConnectionId))
const schedule = computed(() => state.value.schedules.find(item => item.connectionId === active.value?.id))
const running = computed(() => busy.value || state.value.activity?.state === 'running' || schedule.value?.status === 'running')
const frequency = computed(() => !active.value ? initialFrequency.value : schedule.value?.policy.frequency === 'hourly' ? 'hourly' : schedule.value?.policy.frequency === 'weekly' ? 'weekly' : 'daily')
const frequencyLabel = computed(() => ({ hourly: text('每小时', 'Hourly'), daily: text('每天', 'Daily'), weekly: text('每周', 'Weekly') })[frequency.value])
watch(() => state.value.selectedAdapter, () => {
  initialFrequency.value = 'daily'
})
watch(showSelection, (visible) => {
  if (!visible)
    pendingConnection.value = undefined
})
const status = computed(() => {
  if (!state.value.enabled)
    return text('未开启', 'Not enabled')
  if (!active.value)
    return text('填写连接信息，保存并备份后开始自动备份。', 'Complete the connection and choose Save and back up to start automatic backups.')
  if (state.value.scheduleError)
    return text('自动备份配置无法读取，请检查后重试。', 'Automatic backup settings could not be read. Check and try again.')
  const current = schedule.value
  if (current?.status === 'running') {
    const transfer = state.value.activity
    const progress = transfer?.state === 'running' && transfer.totalBytes ? ` ${Math.floor(transfer.completedBytes / transfer.totalBytes * 100)}%` : ''
    return text('正在备份…', 'Backing up…') + progress
  }
  if (current?.status === 'waiting')
    return text('准备备份，任务忙时会等待空闲。', 'Preparing backup; waiting for tasks to finish if needed.')
  if (current?.status === 'failed')
    return current.error?.includes('AUTHENTICATION') ? text('备份失败，请检查账号和密码。修正后保存可重试。', 'Backup failed. Check the credentials and save to retry.') : text('上次备份未完成，将自动重试，也可点击立即备份。', 'The last backup did not complete. It will retry automatically, or you can back up now.')
  const last = current?.lastSuccessAt ? new Date(current.lastSuccessAt).toLocaleString(english.value ? 'en-US' : 'zh-CN') : null
  const next = current?.nextRunAt ? new Date(current.nextRunAt).toLocaleString(english.value ? 'en-US' : 'zh-CN') : null
  return [
    last ? text(`上次备份：${last}`, `Last backup: ${last}`) : text('尚未备份', 'No backups yet'),
    next ? text(`下次备份：${next}`, `Next backup: ${next}`) : text(`${frequencyLabel.value}自动备份`, `${frequencyLabel.value} backups`),
  ].join(' · ')
})
const api = () => window.lexoraDesktop!.sync
let unsubscribe: (() => void) | undefined
async function perform(action: () => Promise<unknown>) {
  if (running.value)
    return
  busy.value = true
  error.value = ''
  try {
    await action()
  }
  catch (failure) {
    const detail = failure instanceof Error ? failure.message : ''
    const description = detail.includes('AUTHENTICATION') ? text('认证失败，请检查账号、密码或访问密钥。', 'Authentication failed. Check your credentials.') : detail.includes('BUCKET_MISSING') ? text('存储桶不存在，请检查名称和服务地址。', 'Bucket not found. Check its name and endpoint.') : detail.includes('CREDENTIAL_STORE') ? text('系统安全存储不可用，凭据尚未保存。', 'Secure storage is unavailable. Credentials have not been saved.') : text('操作未完成，请检查连接后重试。本地数据可继续使用。', 'The operation did not complete. Check the connection and retry. Local data remains available.')
    if (showSelection.value)
      error.value = description
    else
      message.error(description)
  }
  finally { busy.value = false }
}
function selectBackup(connection?: SyncConnectionInput) {
  pendingConnection.value = connection
  error.value = ''
  showSelection.value = true
}
async function setFrequency(value: 'hourly' | 'daily' | 'weekly') {
  if (!active.value) {
    initialFrequency.value = value
    return
  }
  await perform(async () => {
    state.value = await api().setFrequency(value)
  })
}
async function backupNow(options: BackupOptions) {
  await perform(async () => {
    const connection = pendingConnection.value
    state.value = await cloudBackup.backupNow(options, connection ? { connection, frequency: frequency.value } : undefined)
    if (connection)
      formRevision.value++
    showSelection.value = false
  })
}
onMounted(() => {
  unsubscribe = api().onChanged((next) => {
    state.value = next
  })
  void perform(async () => {
    state.value = await api().state()
    loaded.value = true
  })
})
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <section :aria-label="text('云备份', 'Cloud backup')">
    <DesktopSettingsGroup>
      <DesktopSettingRow :label="text('启用云备份', 'Enable cloud backup')" :description="status" toggle>
        <template #labelExtra>
          <DesktopIcon :component="CloudBackupIcon" :size="16" class="text-muted" />
        </template>
        <template #default="{ controlAttrs }">
          <NSwitch v-bind="controlAttrs" :round="false" :value="state.enabled" :disabled="running || !loaded" :aria-disabled="running || !loaded" @update:value="perform(async () => { state = await api().setEnabled($event) })" />
        </template>
      </DesktopSettingRow>
      <template v-if="loaded && state.enabled">
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="text('存储服务', 'Storage service')" toggle>
          <DesktopSegmentedControl v-bind="controlAttrs" :model-value="state.selectedAdapter" :disabled="running" :options="[{ label: 'WebDAV', value: 'webdav' }, { label: text('S3 兼容', 'S3 compatible'), value: 's3' }]" @update:model-value="perform(async () => { state = await api().selectAdapter($event as 'webdav' | 's3') })" />
        </DesktopSettingRow>
        <SyncConnectionForm :key="`${state.selectedAdapter}-${active?.id ?? 'new'}-${formRevision}`" :form-id="connectionFormId" :connection="active ?? null" :adapter="state.selectedAdapter" :busy="running" :frequency="frequency" @backup="selectBackup" @frequency="setFrequency" @test="perform(async () => { await api().testConnection($event); message.success(text('连接正常', 'Connection successful')) })" />
      </template>
    </DesktopSettingsGroup>
    <BackupSelectionDialog v-model:show="showSelection" :english="english" :busy="busy" :error="error" :initial="schedule?.policy" :saving="!!pendingConnection" scheduled immediate @confirm="backupNow" />
  </section>
</template>
