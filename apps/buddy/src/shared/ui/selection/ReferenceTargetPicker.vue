<script setup lang="ts">
import type { ReferenceTargetChoice, ReferenceTargetOption } from './useReferenceTargetPicker'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Add20Regular, ArrowRight20Regular, Copy20Regular, SplitHorizontal20Regular } from '@vicons/fluent'
import { NButton, NEllipsis, NScrollbar } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  language: BuddyLocale
  title: string
  targets: readonly ReferenceTargetOption[]
  allowClipboard: boolean
}>()
const emit = defineEmits<{ choose: [choice: ReferenceTargetChoice] }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <div class="reference-target-picker flex min-w-0 flex-col gap-5">
    <NEllipsis :line-clamp="2" class="text-sm text-muted">
      {{ title }}
    </NEllipsis>
    <section class="min-w-0">
      <h3 class="m-0 mb-2 text-xs text-muted font-medium">
        {{ t('desktop.chat.quotePanes') }}
      </h3>
      <NScrollbar v-if="targets.length" class="max-h-52">
        <div class="flex flex-col gap-2">
          <NButton v-for="target in targets" :key="target.id" block class="reference-target-card h-18" :aria-label="target.label" @click="emit('choose', { kind: 'view', id: target.id })">
            <DesktopIcon :component="SplitHorizontal20Regular" :size="20" class="shrink-0 text-muted" aria-hidden="true" />
            <span class="min-w-0 flex flex-1 flex-col gap-1 text-left">
              <NEllipsis class="font-medium">{{ target.pane?.title ?? target.label }}</NEllipsis>
              <span v-if="target.pane" class="text-xs text-muted">{{ t('desktop.chat.quotePaneNumber', { index: target.pane.index }) }}</span>
            </span>
            <DesktopIcon :component="ArrowRight20Regular" :size="18" class="shrink-0 text-muted" aria-hidden="true" />
          </NButton>
        </div>
      </NScrollbar>
      <p v-else class="m-0 px-2 py-2 text-sm text-muted">
        {{ t('desktop.chat.quoteNoOpenPanes') }}
      </p>
    </section>
    <div class="flex gap-3 border-t border-t-solid border-t-border pt-4">
      <NButton type="primary" class="h-10 min-w-0 flex-1" @click="emit('choose', { kind: 'new-task' })">
        <template #icon>
          <DesktopIcon :component="Add20Regular" :size="18" aria-hidden="true" />
        </template>
        {{ t('desktop.chat.quoteNewTask') }}
      </NButton>
      <NButton v-if="allowClipboard" type="primary" class="h-10 min-w-0 flex-1" @click="emit('choose', { kind: 'clipboard' })">
        <template #icon>
          <DesktopIcon :component="Copy20Regular" :size="18" aria-hidden="true" />
        </template>
        {{ t('desktop.chat.quoteCopyReference') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
.reference-target-card {
  :deep(.n-button__content) {
    min-width: 0;
    width: 100%;
    justify-content: flex-start;
    gap: 12px;
  }
}
</style>
