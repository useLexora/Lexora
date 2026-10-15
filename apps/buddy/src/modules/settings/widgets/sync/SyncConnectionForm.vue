<script setup lang="ts">
import type { SyncConnection, SyncConnectionInput } from '@buddy-shared/sync/syncApi'
import type { MessageReactive } from 'naive-ui'
import { remoteDirectorySchema, syncConnectionInputSchema } from '@buddy-shared/sync/syncApi'
import { NButton, NInput, NSelect, NSwitch, useMessage } from 'naive-ui'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { cloudBackupError } from '../../model/cloudBackupError'
import { useSettingsContext } from '../../settingsContext'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'

const props = defineProps<{ formId: string, connection: SyncConnection | null, adapter: SyncConnection['adapter'], busy: boolean, frequency: 'hourly' | 'daily' | 'weekly' }>()
const emit = defineEmits<{ backup: [connection?: SyncConnectionInput], frequency: [value: 'hourly' | 'daily' | 'weekly'] }>()
const { applicationSettings } = useSettingsContext()
const english = computed(() => applicationSettings.language.value === 'en-US')
const text = (zh: string, en: string) => english.value ? en : zh
const error = ref('')
const testing = ref(false)
const message = useMessage()
const fieldError = ref<{ field: 'endpoint' | 'directory' | 'credentials' | 'bucket', message: string }>()
let revision = 0
let testMessage: MessageReactive | undefined
const credentialLoading = ref(!!props.connection)
const credentialLoaded = ref(!props.connection)
let active = true
onUnmounted(() => {
  active = false
  testMessage?.destroy()
})
const connection = props.connection
const s3 = connection?.adapter === 's3' ? connection : undefined
const displayDirectory = (value: string) => `/${value.replace(/^\/+|\/+$/g, '')}`
const form = ref({
  adapter: props.adapter,
  name: connection?.name ?? 'lexora',
  endpoint: connection?.endpoint ?? '',
  username: connection?.adapter === 'webdav' ? connection.username : '',
  password: '',
  bucket: s3?.bucket ?? '',
  region: s3?.region ?? '',
  prefix: displayDirectory(s3?.prefix ?? 'lexora'),
  directory: displayDirectory(connection?.adapter === 'webdav' ? connection.directory ?? 'lexora' : 'lexora'),
  accessKeyId: s3?.accessKeyId ?? '',
  pathStyle: s3?.pathStyle ?? true,
})
watch(form, () => {
  revision++
  testMessage?.destroy()
  testMessage = undefined
  error.value = ''
  fieldError.value = undefined
}, { deep: true, flush: 'sync' })
const backupLocation = computed(() => {
  const value = form.value
  try {
    const endpoint = new URL(value.endpoint)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      return ''
    const parsedDirectory = remoteDirectorySchema.safeParse(value.adapter === 's3' ? value.prefix : value.directory)
    if (!parsedDirectory.success)
      return ''
    if (value.adapter === 's3')
      return value.bucket ? `s3://${value.bucket}/${parsedDirectory.data ? `${parsedDirectory.data}/` : ''}` : ''
    const directory = parsedDirectory.data.split('/').filter(Boolean).map(encodeURIComponent).join('/')
    return new URL(directory ? `${directory}/` : '', `${value.endpoint.replace(/\/+$/, '')}/`).href
  }
  catch { return '' }
})
const savedForm = ref(JSON.stringify(form.value))
const dirty = computed(() => savedForm.value !== JSON.stringify(form.value))
const frequencies = computed(() => [
  { value: 'hourly', label: text('每小时', 'Hourly') },
  { value: 'daily', label: text('每天', 'Daily') },
  { value: 'weekly', label: text('每周', 'Weekly') },
])
const isS3 = computed(() => form.value.adapter === 's3')
const endpointPlaceholder = computed(() => isS3.value ? 'https://s3.us-east-1.amazonaws.com' : 'https://dav.example.com/backup/')
onMounted(async () => {
  if (!connection)
    return
  try {
    const password = await window.lexoraDesktop!.sync.credential(connection.id)
    if (active) {
      form.value.password = password
      credentialLoaded.value = true
      savedForm.value = JSON.stringify({ ...JSON.parse(savedForm.value), password })
    }
  }
  catch {
    if (active)
      error.value = text('无法读取已保存的凭据。可输入新密码替换，留空则保留原值。', 'Unable to read the saved credential. Enter a replacement or leave it blank to keep the current value.')
  }
  finally { credentialLoading.value = false }
})
function submit(action: 'backup' | 'test' = 'backup') {
  if (props.busy || testing.value || credentialLoading.value)
    return
  error.value = ''
  fieldError.value = undefined
  if (action === 'backup' && connection && !dirty.value) {
    emit('backup')
    return
  }
  const common = { name: form.value.name, endpoint: form.value.endpoint, ...(connection ? { id: connection.id } : {}), ...(credentialLoaded.value || form.value.password ? { password: form.value.password } : {}) }
  const input = isS3.value
    ? { ...common, adapter: 's3', bucket: form.value.bucket, region: form.value.region, prefix: form.value.prefix, accessKeyId: form.value.accessKeyId, pathStyle: form.value.pathStyle }
    : { ...common, adapter: 'webdav', username: form.value.username, directory: form.value.directory }
  const parsed = syncConnectionInputSchema.safeParse(input)
  if (!parsed.success || (isS3.value && (credentialLoaded.value || !connection) && !form.value.password)) {
    error.value = isS3.value ? text('请填写有效的服务地址、存储桶、区域和访问密钥。', 'Enter a valid endpoint, bucket, region and access credentials.') : text('请填写有效的 WebDAV 地址和备份目录，账号密码单独填写。', 'Enter a valid WebDAV URL and backup directory. Enter credentials separately.')
    return
  }
  if (action === 'test')
    void testConnection(parsed.data)
  else
    emit('backup', parsed.data)
}
async function testConnection(input: SyncConnectionInput) {
  testing.value = true
  const startedRevision = revision
  try {
    await window.lexoraDesktop!.sync.testConnection(input)
    if (active && revision === startedRevision)
      testMessage = message.success(text('连接正常，备份目录可读写，测试文件已清理。', 'The backup directory is readable and writable. The test file has been removed.'))
  }
  catch (failure) {
    if (!active || revision !== startedRevision)
      return
    const code = failure instanceof Error ? failure.message.match(/\bSYNC_[A-Z_]+\b/)?.[0] : undefined
    const field = code === 'SYNC_AUTHENTICATION_FAILED'
      ? 'credentials'
      : code === 'SYNC_ENDPOINT_MISSING' || code === 'SYNC_WEBDAV_UNAVAILABLE' || code === 'SYNC_REDIRECT_REFUSED'
        ? 'endpoint'
        : code === 'SYNC_BUCKET_MISSING'
          ? 'bucket'
          : code === 'SYNC_PERMISSION_DENIED' || code === 'SYNC_TEST_CLEANUP_FAILED' || code?.startsWith('SYNC_REMOTE_DIRECTORY') ? 'directory' : undefined
    const description = cloudBackupError(failure, english.value)
    if (field)
      fieldError.value = { field, message: description }
    else
      testMessage = message.error(description)
  }
  finally {
    if (active)
      testing.value = false
  }
}
</script>

<template>
  <form :id="formId" class="sync-form" :spellcheck="false" @submit.prevent="submit()">
    <p v-if="error" role="alert" class="m-0 p-[0.9rem] border-b border-b-solid border-border text-danger text-[0.75rem]">
      {{ error }}
    </p>
    <DesktopSettingRow v-slot="{ controlAttrs }" :label="text('地址', 'Endpoint')" :error="fieldError?.field === 'endpoint' ? fieldError.message : null" :description="isS3 ? text('服务商提供的 S3 API 地址，不含存储桶名。', 'The S3 API endpoint from your provider, without the bucket name.') : text('填写当前账号可访问的 WebDAV 服务地址，备份目录相对于此地址。', 'The WebDAV endpoint accessible to this account. The backup directory is relative to this URL.')">
      <NInput v-model:value="form.endpoint" :disabled="busy" :placeholder="endpointPlaceholder" :input-props="{ ...controlAttrs, inputmode: 'url', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off' }" />
    </DesktopSettingRow>
    <template v-if="isS3">
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="text('存储桶', 'Bucket')" :error="fieldError?.field === 'bucket' ? fieldError.message : null" :description="text('填写已创建的存储桶名称。', 'Enter the name of an existing bucket.')">
        <NInput v-model:value="form.bucket" :disabled="busy" :input-props="controlAttrs" />
      </DesktopSettingRow>
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="text('区域', 'Region')" :description="text('AWS 填存储桶所在区域；其他服务按其文档填写，例如 R2 使用 auto。', 'For AWS, use the bucket’s region. Follow your provider’s instructions; R2 uses auto.')">
        <NInput v-model:value="form.region" :disabled="busy" :placeholder="text('例如 us-east-1 或 auto', 'For example, us-east-1 or auto')" :input-props="controlAttrs" />
      </DesktopSettingRow>
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="text('备份目录', 'Backup directory')" :error="fieldError?.field === 'directory' ? fieldError.message : null" :description="text('存储桶内的目录，可改为 /backups/lexora 等路径。', 'Directory within the bucket, such as /backups/lexora.')">
        <NInput v-model:value="form.prefix" :disabled="busy" placeholder="/lexora" :input-props="controlAttrs" />
      </DesktopSettingRow>
      <DesktopSettingRow v-slot="{ controlAttrs }" label="Access Key ID" :description="text('服务商提供的访问密钥 ID。', 'The access key ID provided by your storage service.')">
        <NInput v-model:value="form.accessKeyId" :disabled="busy" :input-props="{ ...controlAttrs, autocomplete: 'off' }" />
      </DesktopSettingRow>
      <DesktopSettingRow v-slot="{ controlAttrs }" label="Secret Access Key" :error="fieldError?.field === 'credentials' ? fieldError.message : null" :description="text('与访问密钥 ID 配对的密钥，保存在本机安全存储中。', 'The matching secret key, saved in this device’s secure storage.')">
        <NInput v-model:value="form.password" type="password" show-password-on="click" :disabled="busy || credentialLoading" :placeholder="credentialLoading ? text('正在读取…', 'Loading…') : ''" :input-props="{ ...controlAttrs, autocomplete: 'new-password' }" />
      </DesktopSettingRow>
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="text('路径式地址', 'Path-style addressing')" :description="text('开启：服务地址/存储桶；关闭：存储桶.服务域名。按服务商要求选择。', 'On: endpoint/bucket. Off: bucket.endpoint. Choose the style your provider requires.')" toggle>
        <NSwitch v-model:value="form.pathStyle" v-bind="controlAttrs" :round="false" :disabled="busy" :aria-disabled="busy" />
      </DesktopSettingRow>
    </template>
    <template v-else>
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="text('备份目录', 'Backup directory')" :error="fieldError?.field === 'directory' ? fieldError.message : null" :description="text('上述地址下的目录，可改为 /backups/lexora 等路径。', 'Directory beneath the endpoint, such as /backups/lexora.')">
        <NInput v-model:value="form.directory" :disabled="busy" placeholder="/lexora" :input-props="controlAttrs" />
      </DesktopSettingRow>
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="text('账号', 'Username')">
        <NInput v-model:value="form.username" :disabled="busy" :input-props="{ ...controlAttrs, autocomplete: 'off' }" />
      </DesktopSettingRow>
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="text('密码', 'Password')" :error="fieldError?.field === 'credentials' ? fieldError.message : null">
        <NInput v-model:value="form.password" type="password" show-password-on="click" :disabled="busy || credentialLoading" :placeholder="credentialLoading ? text('正在读取…', 'Loading…') : ''" :input-props="{ ...controlAttrs, autocomplete: 'new-password' }" />
      </DesktopSettingRow>
    </template>
    <p v-if="backupLocation" class="m-0 px-[0.9rem] pt-[0.75rem] text-[0.7rem] text-muted leading-[1.5] break-all">
      {{ text('备份位置：', 'Backup location: ') }}{{ backupLocation }}
    </p>
    <div class="flex flex-wrap items-center justify-end gap-2 p-[0.9rem]">
      <NButton :loading="testing" :disabled="busy || credentialLoading || testing" @click="submit('test')">
        {{ testing ? text('正在测试…', 'Testing…') : text('测试连接', 'Test connection') }}
      </NButton>
      <div class="flex items-stretch gap-2 ml-auto">
        <span :id="`${formId}-frequency-label`" class="flex items-center whitespace-nowrap text-[0.875rem] text-muted leading-none">{{ text('备份频率', 'Backup frequency') }}</span>
        <NSelect :value="frequency" :options="frequencies" :disabled="busy" :aria-labelledby="`${formId}-frequency-label`" class="w-[6.5rem]" @update:value="emit('frequency', $event)" />
      </div>
      <NButton attr-type="submit" type="primary" :disabled="busy || credentialLoading || testing">
        {{ !connection || dirty ? text('保存并备份', 'Save and back up') : text('立即备份', 'Back up now') }}
      </NButton>
    </div>
  </form>
</template>

<style scoped lang="scss">
.sync-form :deep(input) {
  font-variant-ligatures: none;
}
</style>
