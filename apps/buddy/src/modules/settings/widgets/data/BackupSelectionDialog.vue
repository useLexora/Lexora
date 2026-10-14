<script setup lang="ts">
import type { BackupOptions, BackupScope } from '@buddy-shared/storage/backupScope'
import type { SnapshotSummary } from '@buddy-shared/storage/snapshot'
import { backupScopes } from '@buddy-shared/storage/backupScope'
import { NAlert, NButton, NCheckbox, NInput, NModal, NScrollbar } from 'naive-ui'
import { computed, shallowRef, watch } from 'vue'
import { backupScopeLabels } from './backupScopeLabels'

const props = defineProps<{ english: boolean, initial?: BackupOptions, scheduled?: boolean, immediate?: boolean, saving?: boolean, snapshot?: SnapshotSummary | null, root?: string, busy: boolean, error: string }>()
const emit = defineEmits<{ confirm: [options: BackupOptions] }>()
const show = defineModel<boolean>('show', { required: true })
const scopes = shallowRef<BackupScope[]>([])
const credentials = shallowRef(false)
const password = shallowRef('')
const confirmation = shallowRef('')
const text = (zh: string, en: string) => props.english ? en : zh
const restoring = computed(() => !!props.snapshot)
const available = computed(() => props.snapshot?.scopes ?? backupScopes)
const choices = computed(() => backupScopes.map(id => ({ id, ...backupScopeLabels[id], available: available.value.includes(id) })))
const canIncludeCredentials = computed(() => (!restoring.value || props.snapshot?.credentials) && scopes.value.some(scope => scope === 'providers' || scope === 'connections'))
const keptPassword = computed(() => props.scheduled && props.initial?.credentials && !password.value)
const valid = computed(() => scopes.value.length && (!credentials.value || (canIncludeCredentials.value && (keptPassword.value || (password.value.length >= 8 && (restoring.value || password.value === confirmation.value))))))
watch(show, (visible) => {
  password.value = ''
  confirmation.value = ''
  if (visible) {
    scopes.value = [...(props.initial?.scopes ?? available.value)]
    credentials.value = props.initial?.credentials ?? false
    password.value = props.initial?.password ?? ''
    confirmation.value = password.value
  }
})
watch(canIncludeCredentials, (available) => {
  if (!available)
    credentials.value = false
})
function toggle(id: BackupScope, selected: boolean) {
  scopes.value = selected ? [...scopes.value, id] : scopes.value.filter(scope => scope !== id)
}
function confirm() {
  if (valid.value)
    emit('confirm', { scopes: [...scopes.value], credentials: credentials.value, ...(credentials.value && password.value ? { password: password.value } : {}) })
}
</script>

<template>
  <NModal v-model:show="show" preset="card" :title="immediate ? text('立即备份', 'Back up now') : scheduled ? text('自动备份内容', 'Automatic backup content') : restoring ? text('恢复备份', 'Restore backup') : text('创建备份', 'Create backup')" :mask-closable="!busy" :closable="!busy" :close-on-esc="!busy" :style="{ width: 'min(620px, calc(100vw - 32px))' }">
    <div class="grid gap-4">
      <p class="m-0 text-[0.75rem] text-muted leading-relaxed">
        {{ immediate ? text('选择此次及后续自动备份的内容。', 'Choose content for this backup and future automatic backups.') : restoring ? text('恢复所选内容，同一记录或同名文件将被覆盖，其他内容保留。必要的关联资料会一并补充。', 'Restore selected content, replacing matching records and files while keeping other data. Missing required references will also be added.') : text('选择要保存的内容。本地与云端使用同一份备份。', 'Choose what to save. Local and cloud backups use the same format.') }}
      </p>
      <NScrollbar :style="{ maxHeight: 'min(52vh, 30rem)' }">
        <div class="grid gap-0">
          <div v-for="item in choices" :key="item.id" class="flex gap-3 items-start py-3 border-b border-b-solid border-border last:border-b-0" :class="item.available ? 'cursor-pointer' : 'opacity-45'">
            <NCheckbox :checked="scopes.includes(item.id)" :disabled="busy || !item.available" :aria-disabled="busy || !item.available" :aria-label="english ? item.en : item.zh" @update:checked="toggle(item.id, $event)">
              <span class="grid gap-1">
                <strong class="text-[0.8rem] font-500">{{ english ? item.en : item.zh }}<span v-if="!item.available" class="ml-2 text-[0.7rem] font-normal">{{ text('备份未包含', 'Not in this backup') }}</span></strong>
                <span class="text-[0.7rem] text-muted">{{ english ? item.hintEn : item.hint }}</span>
              </span>
            </NCheckbox>
          </div>
        </div>
      </NScrollbar>
      <div v-if="canIncludeCredentials" class="grid gap-3 border-t border-t-solid border-border pt-3">
        <NCheckbox v-model:checked="credentials" :disabled="busy">
          {{ text('包含密钥（口令加密）', 'Include credentials (password protected)') }}
        </NCheckbox>
        <template v-if="credentials">
          <NInput v-model:value="password" type="password" show-password-on="click" :disabled="busy" :placeholder="scheduled && initial?.credentials ? text('留空保留已保存的口令', 'Leave blank to keep the saved password') : restoring ? text('输入备份口令', 'Backup password') : text('设置备份口令，至少 8 位', 'Set a backup password, at least 8 characters')" :aria-label="text('备份口令', 'Backup password')" />
          <NInput v-if="!restoring" v-model:value="confirmation" type="password" show-password-on="click" :disabled="busy" :placeholder="text('再次输入口令', 'Confirm password')" :aria-label="text('确认口令', 'Confirm password')" />
          <p class="m-0 text-[0.7rem] text-muted">
            {{ scheduled ? text('为自动执行，口令将保存在本机安全存储中；请另行记住口令，以便在其他设备恢复。OAuth 登录需重新授权。', 'The password is stored securely on this device for automatic backups. Keep a separate copy to restore on another device. OAuth requires signing in again.') : text('口令无法找回。OAuth 登录需重新授权。', 'The password cannot be recovered. OAuth requires signing in again.') }}
          </p>
        </template>
      </div>
      <div v-if="restoring" class="text-[0.75rem] leading-relaxed">
        <p class="m-0">
          {{ text('恢复到当前数据目录', 'Restore to the current data directory') }}
        </p>
        <p class="mt-1 mb-2 font-mono text-muted break-all">
          {{ root }}
        </p>
        <p class="m-0 text-muted">
          {{ text('应用将重启。恢复前的数据会保留为副本；恢复的自动化、插件及 Skills 需重新启用。', 'The app will restart and preserve a recovery copy. Restored automations, plugins and skills need to be enabled again.') }}
        </p>
      </div>
      <NAlert v-if="error" type="error" :show-icon="false">
        {{ error }}
      </NAlert>
      <div class="flex justify-end gap-2">
        <NButton :disabled="busy" @click="show = false">
          {{ text('取消', 'Cancel') }}
        </NButton>
        <NButton type="primary" :loading="busy" :disabled="!valid || busy" @click="confirm">
          {{ saving ? text('保存并备份', 'Save and back up') : immediate ? text('立即备份', 'Back up now') : scheduled ? text('确定范围', 'Confirm content') : restoring ? text('重启并恢复', 'Restart and restore') : text('创建备份', 'Create backup') }}
        </NButton>
      </div>
    </div>
  </NModal>
</template>
