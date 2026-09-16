<script setup lang="ts">
import type { ProxySettings } from '@buddy-shared/network/proxySettings'
import type { ApplicationSettingsProps } from './typing'
import { proxySettingsSchema } from '@buddy-shared/network/proxySettings'
import { NButton, NInput } from 'naive-ui'
import { computed, shallowRef, useId, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const groupId = useId()
const mode = shallowRef<ProxySettings['mode']>('system')
const server = shallowRef('')
const pending = shallowRef(false)
const failed = shallowRef(false)
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
  pending.value = true
  failed.value = false
  try {
    failed.value = !await props.updateSettings({ proxy: parsed.data })
    if (failed.value && props.config)
      mode.value = props.config.proxy.mode
  }
  finally {
    pending.value = false
  }
}

async function select(next: ProxySettings['mode']) {
  mode.value = next
  invalid.value = false
  failed.value = false
  if (next !== 'custom') {
    server.value = props.config?.proxy.server ?? ''
    await save()
  }
}
</script>

<template>
  <section v-if="config" class="desktop-proxy-settings">
    <h2>{{ t('desktop.settings.proxy.title') }}</h2>
    <div class="desktop-proxy-settings__group">
      <div class="desktop-proxy-settings__row">
        <div class="desktop-proxy-settings__label">
          <strong :id="`${groupId}-label`">{{ t('desktop.settings.proxy.mode') }}</strong>
          <small>{{ t('desktop.settings.proxy.description') }}</small>
        </div>
        <div class="desktop-proxy-settings__modes" role="radiogroup" :aria-labelledby="`${groupId}-label`" :aria-busy="pending" :style="{ '--selected-index': selectedIndex }">
          <span class="desktop-proxy-settings__slider" aria-hidden="true" />
          <label v-for="option in modes" :key="option.value" :class="{ 'is-selected': mode === option.value }">
            <input
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
      </div>
      <form v-if="mode === 'custom'" class="desktop-proxy-settings__custom" @submit.prevent="save">
        <label :for="`${groupId}-server`">{{ t('desktop.settings.proxy.server') }}</label>
        <NInput
          v-model:value="server"
          :input-props="{ 'id': `${groupId}-server`, 'aria-describedby': `${groupId}-help` }"
          :disabled="pending"
          :status="invalid ? 'error' : undefined"
          @update:value="invalid = false"
        />
        <small :id="`${groupId}-help`">{{ t('desktop.settings.proxy.serverHelp') }}</small>
        <small v-if="invalid" class="is-error" role="alert">{{ t('desktop.settings.proxy.invalidServer') }}</small>
        <div class="desktop-proxy-settings__actions">
          <NButton attr-type="submit" size="small" :loading="pending" :disabled="!dirty" type="primary">
            {{ t('desktop.settings.proxy.save') }}
          </NButton>
        </div>
      </form>
      <div v-if="failed" class="desktop-proxy-settings__status" role="alert">
        <small class="is-error">{{ error ?? t('desktop.settings.saveFailed') }}</small>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.desktop-proxy-settings {
  display: grid;
  gap: 0.8rem;

  h2 { margin: 0; font-size: 0.92rem; }
  strong, label { font-size: 0.8rem; font-weight: 600; }
  small { color: var(--buddy-text-secondary); font-size: 0.7rem; line-height: 1.5; }
  .is-error { color: var(--buddy-status-danger-text); }
}

.desktop-proxy-settings__group {
  border: 1px solid var(--buddy-border-subtle);
  border-radius: 0.65rem;
  background: var(--buddy-surface-base);
  padding: 0.9rem;
}

.desktop-proxy-settings__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 1rem;
}

.desktop-proxy-settings__label { display: grid; gap: 0.25rem; }

.desktop-proxy-settings__modes {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  width: 15rem;
  max-width: 100%;
  border-radius: 0.65rem;
  background: var(--buddy-surface-subtle);
  padding: 0.2rem;

  label {
    position: relative;
    display: grid;
    min-height: 1.7rem;
    place-items: center;
    border-radius: 0.45rem;
    font-size: 0.75rem;
    font-weight: 400;
    white-space: nowrap;
    color: var(--buddy-text-secondary);
    cursor: pointer;
    transition: color 160ms ease;
  }

  label.is-selected { color: var(--buddy-text-primary); }
  label:has(input:focus-visible) { outline: 2px solid var(--buddy-focus-ring); outline-offset: 2px; }
  label:has(input:disabled) { cursor: wait; }
  input { position: absolute; inset: 0; opacity: 0; cursor: inherit; margin: 0; }
}

.desktop-proxy-settings__slider {
  position: absolute;
  top: 0.2rem;
  bottom: 0.2rem;
  left: 0.2rem;
  width: calc((100% - 0.4rem) / 3);
  border-radius: 0.45rem;
  background: var(--buddy-surface-base);
  box-shadow: var(--buddy-shadow-soft);
  transform: translateX(calc(var(--selected-index) * 100%));
  transition: transform 180ms ease;
}

.desktop-proxy-settings__custom {
  display: grid;
  gap: 0.5rem;
  margin-top: 1rem;
  border-top: 1px solid var(--buddy-border-subtle);
  padding-top: 1rem;
}

.desktop-proxy-settings__actions { display: flex; justify-content: flex-end; }
.desktop-proxy-settings__status { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.65rem; }

@media (max-width: 760px) {
  .desktop-proxy-settings__row { grid-template-columns: minmax(0, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
  .desktop-proxy-settings__slider { transition: none; }
}
</style>
