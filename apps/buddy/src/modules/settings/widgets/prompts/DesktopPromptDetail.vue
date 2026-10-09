<script setup lang="ts">
import type { PromptEntry, PromptVariant } from '../../model/promptCatalog'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Copy20Regular, LockClosed16Regular } from '@vicons/fluent'
import { NButton, useMessage } from 'naive-ui'
import { computed, useId, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopSegmentedControl from '@/shared/ui/segmented-control/DesktopSegmentedControl.vue'
import DesktopPromptContent from './DesktopPromptContent.vue'

const props = defineProps<{
  entry: PromptEntry
  variant: PromptVariant
  language: BuddyLocale
  writeClipboardText: (text: string) => Promise<void>
}>()
const emit = defineEmits<{ selectVariant: [id: string] }>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const headingId = useId()
const document = useTemplateRef('document')
const variantOptions = computed(() => props.entry.variants.map(variant => ({ label: variant.label, value: variant.id })))

watch([() => props.entry.id, () => props.variant.id], () => {
  if (document.value)
    document.value.scrollTop = 0
}, { flush: 'post' })

async function copy() {
  try {
    await props.writeClipboardText(props.variant.content)
    message.success(t('desktop.chat.copied'))
  }
  catch {
    message.error(t('desktop.chat.copyFailed'))
  }
}
</script>

<template>
  <article class="prompt-detail" :aria-labelledby="headingId">
    <header class="prompt-detail__header" :class="{ 'has-variants': entry.variants.length > 1 }">
      <div class="prompt-detail__heading">
        <h2 :id="headingId">
          {{ entry.title }}
        </h2>
        <span class="prompt-detail__status">
          <DesktopIcon :component="LockClosed16Regular" :size="14" />
          {{ t('desktop.prompts.readonly') }}
        </span>
      </div>
      <p class="prompt-detail__description">
        {{ entry.description }}
      </p>
      <div class="prompt-detail__toolbar">
        <div v-if="entry.variants.length > 1" class="prompt-detail__variants">
          <DesktopSegmentedControl
            :model-value="variant.id"
            :options="variantOptions"
            :aria-labelledby="headingId"
            @update:model-value="emit('selectVariant', $event)"
          />
        </div>
        <div class="prompt-detail__actions">
          <NButton size="small" secondary @click="copy">
            <template #icon>
              <DesktopIcon :component="Copy20Regular" />
            </template>
            {{ t('desktop.prompts.copy') }}
          </NButton>
        </div>
      </div>
    </header>
    <div ref="document" class="prompt-detail__document" tabindex="0" :aria-labelledby="headingId">
      <DesktopPromptContent :key="`${entry.id}:${variant.id}`" :content="variant.content" />
    </div>
  </article>
</template>

<style scoped>
.prompt-detail { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; }
.prompt-detail__header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px 16px; flex: none; padding: 18px 24px; border-bottom: 1px solid var(--buddy-border-subtle); }
.prompt-detail__heading { display: flex; grid-column: 1; align-items: center; flex-wrap: wrap; gap: 8px 12px; min-width: 0; }
.prompt-detail__heading h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.prompt-detail__description { grid-column: 1; margin: 0; color: var(--buddy-text-secondary); font-size: 12px; line-height: 1.7; }
.prompt-detail__status { display: inline-flex; flex: none; align-items: center; gap: 4px; color: var(--buddy-text-muted); font-size: 11px; }
.prompt-detail__toolbar { display: flex; grid-column: 2; grid-row: 1 / span 2; align-items: center; gap: 12px; }
.has-variants .prompt-detail__description { grid-column: 1 / -1; }
.has-variants .prompt-detail__toolbar { grid-column: 1 / -1; grid-row: 3; flex-wrap: wrap; margin-top: 4px; }
.prompt-detail__actions { display: flex; flex: none; align-items: center; gap: 8px; margin-left: auto; }
.prompt-detail__document { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 20px 24px 28px; scrollbar-width: thin; scrollbar-color: var(--buddy-border-strong) transparent; }
.prompt-detail__document:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: -2px; }
.prompt-detail__variants { min-width: 0; }
@container (max-width: 720px) {
  .prompt-detail__header { padding: 16px 20px; }
  .prompt-detail__description { grid-column: 1 / -1; }
  .prompt-detail__toolbar { grid-row: 1; }
  .prompt-detail__document { padding: 16px 20px 24px; }
}
</style>
