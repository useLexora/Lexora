<script setup lang="ts">
import type { TypographyPreferences } from '@buddy-shared/typography/typographyPreferences'
import type { ApplicationSettingsProps } from './typing'
import { DEFAULT_TYPOGRAPHY, resolveTypography } from '@buddy-shared/typography/typographyPreferences'
import { NSelect, useMessage } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useLocalFonts } from '../../state/useLocalFonts'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'

const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const { pending, save } = useSettingMutation<keyof TypographyPreferences>(
  patch => props.updateSettings(patch),
  () => message.error(t('desktop.settings.saveFailed')),
)
const preferences = computed(() => props.config?.desktop.typography ?? DEFAULT_TYPOGRAPHY)
const preview = computed(() => resolveTypography(preferences.value))
const { families, loading, load } = useLocalFonts(() => message.error(t('desktop.settings.typography.loadFailed')))
const installedOptions = computed(() => families.value.map(value => ({ label: value, value })))
const fontFields = computed(() => [
  { key: 'uiFont' as const, label: t('desktop.settings.typography.uiFont') },
  { key: 'bodyFont' as const, label: t('desktop.settings.typography.bodyFont') },
  { key: 'codeFont' as const, label: t('desktop.settings.typography.codeFont') },
].map(field => ({
  ...field,
  options: [
    { label: t(field.key === 'codeFont' ? 'desktop.settings.typography.systemMono' : 'desktop.settings.typography.system'), value: '' },
    ...installedOptions.value,
  ],
})))
const sizeOptions = Array.from({ length: 9 }, (_, index) => ({ label: `${index + 12} px`, value: index + 12 }))
</script>

<template>
  <section class="grid gap-[0.8rem]" data-testid="typography-settings">
    <h2 class="m-0 text-[0.92rem]">
      {{ t('desktop.settings.typography.title') }}
    </h2>
    <DesktopSettingsGroup>
      <DesktopSettingRow v-for="field in fontFields" :key="field.key" v-slot="{ controlAttrs }" :label="field.label" :data-testid="`typography-${field.key}`">
        <NSelect
          v-bind="controlAttrs"
          filterable
          tag
          :clearable="preferences[field.key] !== DEFAULT_TYPOGRAPHY[field.key]"
          :options="field.options"
          :value="preferences[field.key]"
          :disabled="pending.has(field.key)"
          :loading="loading || pending.has(field.key)"
          @update:show="load"
          @update:value="save(field.key, { desktop: { typography: { [field.key]: $event ?? DEFAULT_TYPOGRAPHY[field.key] } } })"
        />
      </DesktopSettingRow>
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.typography.bodySize')" data-testid="typography-bodySize">
        <NSelect v-bind="controlAttrs" :clearable="preferences.bodySize !== DEFAULT_TYPOGRAPHY.bodySize" :options="sizeOptions" :value="preferences.bodySize" :disabled="pending.has('bodySize')" :loading="pending.has('bodySize')" @update:value="save('bodySize', { desktop: { typography: { bodySize: $event ?? DEFAULT_TYPOGRAPHY.bodySize } } })" />
      </DesktopSettingRow>
      <div class="grid gap-3 bg-reading p-4 text-reading-fg" data-testid="typography-preview">
        <span class="text-[12px] text-muted" :style="{ fontFamily: preview.ui }">{{ t('desktop.settings.typography.preview') }}</span>
        <p class="m-0 font-400" :style="{ fontFamily: preview.body, fontSize: preview.bodySize, lineHeight: preview.bodyLineHeight }">
          {{ t('desktop.settings.typography.sample') }}
        </p>
        <code class="text-[12px] leading-[20px]" :style="{ fontFamily: preview.mono }">const message = 'Hello, Lexora 2026';</code>
      </div>
    </DesktopSettingsGroup>
  </section>
</template>
