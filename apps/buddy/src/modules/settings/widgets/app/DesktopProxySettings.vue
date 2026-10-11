<script setup lang="ts">
import type { ProxySettings } from '@buddy-shared/network/proxySettings'
import type { ApplicationSettingsProps } from './typing'
import { proxySettingsSchema } from '@buddy-shared/network/proxySettings'
import { NButton, NInput, useMessage } from 'naive-ui'
import { computed, shallowRef, useId, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'

const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const groupId = useId()
const mode = shallowRef<ProxySettings['mode']>('system')
const server = shallowRef('')
const { pending: pendingFields, save: updateSetting } = useSettingMutation<'proxy'>(
  patch => props.updateSettings(patch),
  () => message.error(t('desktop.settings.saveFailed')),
)
const pending = computed(() => pendingFields.value.has('proxy'))
const invalid = shallowRef(false)
const modes = computed(() => [
  { value: 'system' as const, label: t('desktop.settings.proxy.system') },
  { value: 'direct' as const, label: t('desktop.settings.proxy.direct') },
  { value: 'custom' as const, label: t('desktop.settings.proxy.custom') },
])
const selectedIndex = computed(() => modes.value.findIndex(option => option.value === mode.value))
const dirty = computed(() => mode.value !== props.config?.proxy.mode || server.value.trim() !== props.config?.proxy.server)

watch([() => props.config?.proxy.mode, () => props.config?.proxy.server], ([nextMode, nextServer]) => {
  if (!nextMode)
    return
  mode.value = nextMode
  server.value = nextServer ?? ''
}, { immediate: true })

async function save() {
  if (pending.value)
    return
  const parsed = proxySettingsSchema.safeParse({ mode: mode.value, server: server.value })
  invalid.value = !parsed.success
  if (!parsed.success)
    return
  if (!await updateSetting('proxy', { proxy: parsed.data }) && props.config)
    mode.value = props.config.proxy.mode
}

async function select(next: ProxySettings['mode']) {
  mode.value = next
  invalid.value = false
  if (next !== 'custom') {
    server.value = props.config?.proxy.server ?? ''
    await save()
  }
}
</script>

<template>
  <section v-if="config" class="desktop-proxy-settings grid gap-[0.8rem] [container-type:inline-size]">
    <h2 class="m-0 text-[0.92rem]">
      {{ t('desktop.settings.proxy.title') }}
    </h2>
    <div class="border border-solid border-border rounded-[0.65rem] bg-surface p-[0.9rem]">
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.proxy.mode')" :description="t('desktop.settings.proxy.description')" toggle class="[--setting-row-height:0px] [--setting-row-px:0px] [--setting-row-py:0px] [--setting-control-min:0px] [--setting-control-max:max-content]">
        <div class="desktop-proxy-settings__modes relative grid grid-cols-[repeat(3,_minmax(0,_1fr))] w-60 max-w-full rounded-[0.65rem] bg-subtle p-[0.2rem]" v-bind="controlAttrs" role="radiogroup" :aria-busy="pending" :style="{ '--selected-index': selectedIndex }">
          <span class="desktop-proxy-settings__slider absolute top-[0.2rem] bottom-[0.2rem] left-[0.2rem] w-[calc((100%_-_0.4rem)_/_3)] rounded-[0.45rem] bg-surface shadow-soft" aria-hidden="true" />
          <label v-for="option in modes" :key="option.value" class="relative grid min-h-[1.7rem] place-items-center rounded-[0.45rem] text-[0.75rem] font-400 whitespace-nowrap cursor-pointer transition-colors duration-160" :class="mode === option.value ? 'text-fg' : 'text-muted'">
            <input
              class="absolute inset-0 opacity-0 cursor-inherit m-0"
              type="radio"
              :name="groupId"
              :value="option.value"
              :checked="mode === option.value"
              :disabled="pending"
              @change="select(option.value)"
            >
            <span>{{ option.label }}</span>
          </label>
        </div>
      </DesktopSettingRow>
      <form v-if="mode === 'custom'" class="grid gap-2 mt-4 border-t-1 border-t-solid border-t-border pt-4" @submit.prevent="save">
        <label :for="`${groupId}-server`" class="text-[0.8rem] font-600">{{ t('desktop.settings.proxy.server') }}</label>
        <NInput
          v-model:value="server"
          :input-props="{ 'id': `${groupId}-server`, 'aria-describedby': `${groupId}-help` }"
          :disabled="pending"
          :status="invalid ? 'error' : undefined"
          @update:value="invalid = false"
        />
        <small :id="`${groupId}-help`" class="text-muted text-[0.7rem] leading-[1.5]">{{ t('desktop.settings.proxy.serverHelp') }}</small>
        <small v-if="invalid" class="text-danger text-[0.7rem] leading-[1.5]" role="alert">{{ t('desktop.settings.proxy.invalidServer') }}</small>
        <div class="flex justify-end">
          <NButton attr-type="submit" size="small" :loading="pending" :disabled="!dirty" type="primary">
            {{ t('desktop.settings.proxy.save') }}
          </NButton>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped lang="scss">
.desktop-proxy-settings__modes {
  label:has(input:focus-visible) {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: 2px;
  }

  label:has(input:disabled) {
    cursor: wait;
  }
}

.desktop-proxy-settings__slider {
  transform: translateX(calc(var(--selected-index) * 100%));
  transition: transform 180ms ease;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
}
</style>
