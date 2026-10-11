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
  <article class="prompt-detail flex flex-1 min-w-0 min-h-0 flex-col overflow-hidden" :aria-labelledby="headingId">
    <header class="prompt-detail__header grid grid-cols-[minmax(0,_1fr)_auto] items-center flex-none py-[18px] px-[24px] border-b-1 border-b-solid border-b-border" :class="{ 'has-variants': entry.variants.length > 1 }">
      <div class="prompt-detail__heading flex col-[1] items-center flex-wrap min-w-0">
        <h2 :id="headingId">
          {{ entry.title }}
        </h2>
        <span class="inline-flex flex-none items-center gap-[4px] text-muted text-[11px]">
          <DesktopIcon :component="LockClosed16Regular" :size="14" />
          {{ t('desktop.prompts.readonly') }}
        </span>
      </div>
      <p class="prompt-detail__description col-[1] m-0 text-muted text-[12px] leading-[1.7]">
        {{ entry.description }}
      </p>
      <div class="prompt-detail__toolbar flex col-[2] row-[1_/_span_2] items-center gap-[12px]">
        <div v-if="entry.variants.length > 1" class="prompt-detail__variants min-w-0">
          <DesktopSegmentedControl
            :model-value="variant.id"
            :options="variantOptions"
            :aria-labelledby="headingId"
            @update:model-value="emit('selectVariant', $event)"
          />
        </div>
        <div class="flex flex-none items-center gap-[8px] ml-auto">
          <NButton size="small" secondary @click="copy">
            <template #icon>
              <DesktopIcon :component="Copy20Regular" />
            </template>
            {{ t('desktop.prompts.copy') }}
          </NButton>
        </div>
      </div>
    </header>
    <div ref="document" class="prompt-detail__document flex-1 min-w-0 min-h-0 overflow-auto pt-[20px] pr-[24px] pb-[28px] pl-[24px] ui-focus-ring" tabindex="0" :aria-labelledby="headingId">
      <DesktopPromptContent :key="`${entry.id}:${variant.id}`" :content="variant.content" />
    </div>
  </article>
</template>

<style scoped lang="scss">
.prompt-detail__header { gap: 8px 16px; }
.prompt-detail__heading { gap: 8px 12px; }
.prompt-detail__heading h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.has-variants .prompt-detail__description { grid-column: 1 / -1; }
.has-variants .prompt-detail__toolbar { grid-column: 1 / -1; grid-row: 3; flex-wrap: wrap; margin-top: 4px; }

.prompt-detail__document { scrollbar-width: thin; scrollbar-color: var(--buddy-border-strong) transparent; }
@container (max-width: 720px) {
  .prompt-detail__header { padding: 16px 20px; }
  .prompt-detail__description { grid-column: 1 / -1; }
  .prompt-detail__toolbar { grid-row: 1; }
  .prompt-detail__document { padding: 16px 20px 24px; }
}
</style>
