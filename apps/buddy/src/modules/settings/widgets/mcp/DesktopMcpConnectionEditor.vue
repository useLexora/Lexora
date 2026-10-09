<script setup lang="ts">
import type { LocalConnector } from '@buddy-shared/connectors/connectorApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { DesktopConnectorFormValue, DesktopConnectorSavePlan } from '@/modules/settings/model/desktopConnectorForm'
import { connectorsRequestSchemas } from '@buddy-shared/connectors/connectorApi'
import { MCP_TOOL_EXPOSURES, mcpNamespaceBase } from '@buddy-shared/connectors/mcpToolExposure'
import { isPlainHttpEndpointUrl } from '@buddy-shared/network/networkSecurity'
import { NAlert, NButton, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NModal, NScrollbar, NSelect, NTag } from 'naive-ui'
import { computed, reactive, shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { createConnectorSavePlan } from '@/modules/settings/model/desktopConnectorForm'

const props = withDefaults(defineProps<{
  connector: LocalConnector | null
  language: BuddyLocale
  busy: boolean
  error: string | null
  codemodeEnabled: boolean
  initialTransport?: 'stdio' | 'streamable-http'
}>(), {
  initialTransport: 'stdio',
})
const emit = defineEmits<{ close: [], save: [plan: DesktopConnectorSavePlan] }>()
const { t } = useBuddyI18n(() => props.language)
const existing = props.connector
const formId = useId()
const form = reactive<DesktopConnectorFormValue>({
  id: existing?.id ?? crypto.randomUUID(),
  name: existing?.name ?? '',
  toolNamespace: existing?.toolNamespace ?? '',
  toolExposure: existing?.toolExposure ?? 'deferred',
  transport: existing?.transport ?? props.initialTransport,
  command: existing?.transport === 'stdio' ? existing.command : '',
  args: existing?.transport === 'stdio' ? existing.args.join('\n') : '',
  url: existing?.transport === 'streamable-http' ? existing.url : '',
  env: '',
  headers: '',
  bearerToken: '',
})

function tokenizeLine(text: string): string[] {
  const tokens: string[] = []
  const pattern = /[^\s"']+|"([^"]*)"|'([^']*)'/g
  for (const match of text.matchAll(pattern)) {
    if (match[1] !== undefined)
      tokens.push(match[1])
    else if (match[2] !== undefined)
      tokens.push(match[2])
    else
      tokens.push(match[0])
  }
  return tokens
}

function handleCommandInput(value: string) {
  const trimmed = value.trim()
  if (trimmed.includes(' ') && !form.args.trim()) {
    const tokens = tokenizeLine(trimmed)
    if (tokens.length > 1) {
      form.command = tokens[0] ?? ''
      form.args = tokens.slice(1).join('\n')
      return
    }
  }
  form.command = value
}

function updateCommandSelect(value: string | number | null) {
  handleCommandInput(typeof value === 'string' ? value : '')
}

const invalid = shallowRef(false)
const insecureHttp = computed(() => form.transport === 'streamable-http' && isPlainHttpEndpointUrl(form.url.trim()))
const exposureOptions = computed(() => MCP_TOOL_EXPOSURES.filter(value => value !== 'hidden').map(value => ({ value, label: t(`desktop.mcp.exposure.${value}`) })))
const commandOptions = ['npx', 'uvx', 'pnpm', 'bunx', 'docker', 'node'].map(value => ({ label: value, value }))
const namespacePlaceholder = computed(() => mcpNamespaceBase(form.name) || 'server')

const title = computed(() => {
  if (existing)
    return t('desktop.mcp.edit')
  return form.transport === 'stdio' ? t('desktop.mcp.addStdio') : t('desktop.mcp.addHttp')
})

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
  <NModal
    show
    preset="card"
    class="mcp-editor"
    :style="{ width: 'min(560px, calc(100vw - 48px))' }"
    :content-style="{ padding: 0 }"
    :mask-closable="!busy"
    :closable="!busy"
    @close="emit('close')"
    @update:show="value => !value && emit('close')"
  >
    <template #header>
      <div class="mcp-editor__header">
        <span class="mcp-editor__title">{{ title }}</span>
        <NTag v-if="existing" size="small" :bordered="false">
          {{ form.transport === 'stdio' ? 'Stdio' : 'HTTP' }}
        </NTag>
      </div>
    </template>
    <NScrollbar style="max-height: calc(100vh - 200px); padding: 16px 24px;">
      <NForm :id="formId" label-placement="top" :disabled="busy" @submit.prevent="submit">
        <NAlert v-if="invalid || error" type="error" :show-icon="false" class="mcp-editor__alert">
          {{ invalid ? t('desktop.mcp.invalidForm') : error }}
        </NAlert>
        <NFormItem :label="t('desktop.mcp.name')">
          <NInput v-model:value="form.name" :maxlength="128" :input-props="{ 'aria-label': t('desktop.mcp.name') }" autofocus />
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
              @update:value="updateCommandSelect"
            />
          </NFormItem>
          <NFormItem :label="t('desktop.mcp.args')">
            <NInput
              v-model:value="form.args"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 4 }"
              :placeholder="t('desktop.mcp.argsHint')"
              :input-props="{ 'aria-label': t('desktop.mcp.args') }"
            />
          </NFormItem>
          <NFormItem :label="t('desktop.mcp.env')">
            <NInput
              v-model:value="form.env"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 4 }"
              :placeholder="t('desktop.mcp.entriesHint')"
              :input-props="{ autocomplete: 'off', spellcheck: false }"
            />
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
        <NCollapse class="mcp-editor__advanced" :default-expanded-names="existing?.toolExposure === 'codemode' || existing?.toolExposure === 'hidden' ? ['tools'] : []">
          <NCollapseItem name="tools" :title="t('desktop.mcp.advanced')">
            <NFormItem :label="t('desktop.mcp.exposure')">
              <NSelect
                v-model:value="form.toolExposure"
                :options="exposureOptions"
                :fallback-option="value => ({ value, label: t('desktop.mcp.exposure.hidden'), disabled: true })"
                :input-props="{ 'aria-label': t('desktop.mcp.exposure') }"
              />
            </NFormItem>
            <NAlert v-if="form.toolExposure === 'codemode' && !codemodeEnabled" type="warning" :bordered="false" :show-icon="false" class="mcp-editor__codemode-alert">
              {{ t('desktop.mcp.codemodeDisabled') }}
            </NAlert>
            <NFormItem :label="t('desktop.mcp.namespace')">
              <NInput
                v-model:value="form.toolNamespace"
                :disabled="!!existing"
                :maxlength="32"
                :placeholder="namespacePlaceholder"
                :input-props="{ 'aria-label': t('desktop.mcp.namespace') }"
              />
            </NFormItem>
          </NCollapseItem>
        </NCollapse>
      </NForm>
    </NScrollbar>
    <template #footer>
      <div class="mcp-editor__footer">
        <div class="mcp-editor__footer-hint">
          <span v-if="!connector">{{ t('desktop.mcp.createHint') }}</span>
          <span v-else-if="connector?.credentialConfigured">{{ t('desktop.mcp.secretHint') }}</span>
        </div>
        <div class="mcp-editor__actions">
          <NButton :disabled="busy" @click="emit('close')">
            {{ t('desktop.mcp.cancel') }}
          </NButton>
          <NButton type="primary" attr-type="submit" :form="formId" :loading="busy">
            {{ t('desktop.mcp.save') }}
          </NButton>
        </div>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.mcp-editor__header { display: flex; align-items: center; gap: 0.6rem; }
.mcp-editor__title { font-weight: 600; font-size: 0.95rem; }
.mcp-editor__advanced { margin-top: 0.5rem; }
.mcp-editor__alert { margin-bottom: 1rem; }
.mcp-editor__codemode-alert { margin: -0.25rem 0 0.85rem; }
.mcp-editor__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 1rem;
}
.mcp-editor__footer-hint {
  color: var(--buddy-text-secondary);
  font-size: 0.78rem;
  flex: 1;
  min-width: 0;
  line-height: 1.4;
}
.mcp-editor__actions {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex: none;
}
</style>
