<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { DesktopConnectorSavePlan } from '@/modules/settings/model/desktopConnectorForm'
import { NAlert, NButton, NInput, NModal } from 'naive-ui'
import { shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { parseConnectorImport } from '@/modules/settings/model/desktopConnectorImport'
import { maskConnectorUrl } from '../../model/desktopConnectorTarget'

const props = defineProps<{ language: BuddyLocale, save: (plan: DesktopConnectorSavePlan) => Promise<unknown>, error: string | null }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useBuddyI18n(() => props.language)
const text = shallowRef('')
const preview = shallowRef<DesktopConnectorSavePlan[]>([])
const invalid = shallowRef(false)
const busy = shallowRef(false)
function parse() {
  try {
    preview.value = parseConnectorImport(text.value)
    invalid.value = false
  }
  catch {
    invalid.value = true
    preview.value = []
  }
}
async function save() {
  busy.value = true
  try {
    while (preview.value.length) {
      if (!await props.save(preview.value[0]!))
        return
      preview.value = preview.value.slice(1)
    }
    emit('close')
  }
  finally { busy.value = false }
}
</script>

<template>
  <NModal show preset="card" :title="t('desktop.mcp.import')" :style="{ width: 'min(580px, calc(100vw - 48px))' }" :mask-closable="!busy" :closable="!busy" @close="emit('close')" @update:show="value => !value && emit('close')">
    <div class="mcp-import grid gap-4">
      <p>{{ t('desktop.mcp.importHint') }}</p>
      <NAlert v-if="invalid || error" type="error" :show-icon="false">
        {{ invalid ? t('desktop.mcp.invalidImport') : error }}
      </NAlert>
      <NInput v-if="!preview.length" v-model:value="text" type="textarea" :autosize="{ minRows: 8, maxRows: 16 }" :input-props="{ 'spellcheck': false, 'autocomplete': 'off', 'aria-label': t('desktop.mcp.import') }" />
      <div v-for="plan in preview" :key="plan.config.id" class="grid gap-[0.35rem] p-3 border border-solid border-border rounded-2">
        <strong>{{ plan.config.name }}</strong>
        <code>{{ plan.config.transport === 'stdio' ? [plan.config.command, ...plan.config.args].map(value => JSON.stringify(value)).join(' ') : maskConnectorUrl(plan.config.url) }}</code>
        <small>{{ t('desktop.mcp.status.disabled') }} · {{ t(plan.credential.mode === 'replace' ? 'desktop.mcp.configured' : 'desktop.mcp.noCredential') }}</small>
      </div>
      <footer>
        <NButton :disabled="busy" @click="preview.length ? preview = [] : emit('close')">
          {{ t('desktop.mcp.cancel') }}
        </NButton>
        <NButton v-if="!preview.length" type="primary" @click="parse">
          {{ t('desktop.mcp.preview') }}
        </NButton>
        <NButton v-else type="primary" :loading="busy" @click="save">
          {{ t('desktop.mcp.importSave', { count: preview.length }) }}
        </NButton>
      </footer>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
.mcp-import p { margin: 0; color: var(--buddy-text-secondary); }

.mcp-import code { white-space: pre-wrap; overflow-wrap: anywhere; }
.mcp-import small { color: var(--buddy-text-secondary); }
.mcp-import footer { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>
