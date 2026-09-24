<script setup lang="ts">
import type { LocalConnector } from '@buddy-shared/connectors/connectorApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { DesktopConnectorFormValue, DesktopConnectorSavePlan } from '@/modules/settings/model/desktopConnectorForm'
import { connectorsRequestSchemas } from '@buddy-shared/connectors/connectorApi'
import { isPlainHttpEndpointUrl } from '@buddy-shared/network/networkSecurity'
import { NAlert, NButton, NForm, NFormItem, NInput, NModal, NSelect } from 'naive-ui'
import { computed, reactive, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { createConnectorSavePlan } from '@/modules/settings/model/desktopConnectorForm'

const props = defineProps<{ connector: LocalConnector | null, language: BuddyLocale, busy: boolean, error: string | null }>()
const emit = defineEmits<{ close: [], save: [plan: DesktopConnectorSavePlan] }>()
const { t } = useBuddyI18n(() => props.language)
const existing = props.connector
const form = reactive<DesktopConnectorFormValue>({
  id: existing?.id ?? crypto.randomUUID(),
  name: existing?.name ?? '',
  transport: existing?.transport ?? 'stdio',
  command: existing?.transport === 'stdio' ? existing.command : '',
  args: existing?.transport === 'stdio' ? JSON.stringify(existing.args) : '[]',
  url: existing?.transport === 'streamable-http' ? existing.url : '',
  env: '',
  headers: '',
  bearerToken: '',
})
const invalid = shallowRef(false)
const insecureHttp = computed(() => form.transport === 'streamable-http' && isPlainHttpEndpointUrl(form.url.trim()))
const transportOptions = computed(() => [{ label: t('desktop.mcp.stdio'), value: 'stdio' }, { label: t('desktop.mcp.http'), value: 'streamable-http' }])
const commandOptions = ['npx', 'uvx', 'pnpm', 'bunx', 'docker', 'node'].map(value => ({ label: value, value }))

function updateCommand(value: string | number | null) {
  form.command = typeof value === 'string' ? value : ''
}

function submit() {
  invalid.value = false
  try {
    const plan = connectorsRequestSchemas.connectorUpsert.parse(createConnectorSavePlan(form, existing))
    emit('save', plan)
  }
  catch { invalid.value = true }
}
</script>

<template>
  <NModal show preset="card" :title="t(connector ? 'desktop.mcp.edit' : 'desktop.mcp.add')" class="mcp-editor" :style="{ width: 'min(580px, calc(100vw - 48px))' }" :mask-closable="!busy" :closable="!busy" @close="emit('close')" @update:show="value => !value && emit('close')">
    <NForm label-placement="top" :disabled="busy" @submit.prevent="submit">
      <NAlert v-if="invalid || error" type="error" :show-icon="false" class="mcp-editor__alert">
        {{ invalid ? t('desktop.mcp.invalidForm') : error }}
      </NAlert>
      <NFormItem :label="t('desktop.mcp.name')">
        <NInput v-model:value="form.name" :maxlength="128" :input-props="{ 'aria-label': t('desktop.mcp.name') }" autofocus />
      </NFormItem>
      <NFormItem :label="t('desktop.mcp.transport')">
        <NSelect v-model:value="form.transport" :options="transportOptions" />
      </NFormItem>
      <template v-if="form.transport === 'stdio'">
        <NFormItem :label="t('desktop.mcp.command')">
          <NSelect
            :value="form.command || null"
            :options="commandOptions"
            filterable
            tag
            :placeholder="t('desktop.mcp.commandHint')"
            :input-props="{ 'aria-label': t('desktop.mcp.command'), 'autocomplete': 'off', 'spellcheck': false }"
            @update:value="updateCommand"
          />
        </NFormItem>
        <NFormItem :label="t('desktop.mcp.args')">
          <NInput v-model:value="form.args" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" :placeholder="t('desktop.mcp.argsHint')" :input-props="{ 'aria-label': t('desktop.mcp.args') }" />
        </NFormItem>
        <NFormItem :label="t('desktop.mcp.env')">
          <NInput v-model:value="form.env" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" :placeholder="t('desktop.mcp.entriesHint')" :input-props="{ autocomplete: 'off', spellcheck: false }" />
        </NFormItem>
      </template>
      <template v-else>
        <NFormItem :label="t('desktop.mcp.url')">
          <NInput v-model:value="form.url" :placeholder="t('desktop.mcp.urlHint')" :input-props="{ 'aria-label': t('desktop.mcp.url') }" />
        </NFormItem>
        <NAlert v-if="insecureHttp" type="warning" :bordered="false" :show-icon="false" class="mcp-editor__alert">
          {{ t('desktop.mcp.httpWarning') }}
        </NAlert>
        <NFormItem :label="t('desktop.mcp.token')">
          <NInput v-model:value="form.bearerToken" type="password" show-password-on="click" :input-props="{ autocomplete: 'new-password' }" />
        </NFormItem>
        <NFormItem :label="t('desktop.mcp.headers')">
          <NInput v-model:value="form.headers" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" :placeholder="t('desktop.mcp.entriesHint')" :input-props="{ autocomplete: 'off', spellcheck: false }" />
        </NFormItem>
      </template>
      <p v-if="!connector" class="mcp-editor__hint">
        {{ t('desktop.mcp.createHint') }}
      </p>
      <p v-if="connector?.credentialConfigured" class="mcp-editor__hint">
        {{ t('desktop.mcp.secretHint') }}
      </p>
      <div class="mcp-editor__actions">
        <NButton :disabled="busy" @click="emit('close')">
          {{ t('desktop.mcp.cancel') }}
        </NButton>
        <NButton type="primary" attr-type="submit" :loading="busy">
          {{ t('desktop.mcp.save') }}
        </NButton>
      </div>
    </NForm>
  </NModal>
</template>

<style scoped>
.mcp-editor__hint { color: var(--buddy-text-secondary); font-size: 0.82rem; }
.mcp-editor__actions { display: flex; justify-content: flex-end; gap: 0.6rem; margin-top: 1rem; }
.mcp-editor__alert { margin-bottom: 1rem; }
</style>
