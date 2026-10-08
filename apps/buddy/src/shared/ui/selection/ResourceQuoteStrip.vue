<script setup lang="ts">
import type { BuddyResourceQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Dismiss16Regular, Document20Regular, Globe20Regular } from '@vicons/fluent'
import { NButton, NPopover, useMessage } from 'naive-ui'
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useSelectionReferences } from './workbenchSelectionReferences'

const props = defineProps<{ quotes: readonly BuddyResourceQuote[], language: BuddyLocale, removable?: boolean, disabled?: boolean }>()
const emit = defineEmits<{ remove: [id: string] }>()
const { t } = useBuddyI18n(() => props.language)
const references = useSelectionReferences()
const message = useMessage()
const expanded = shallowRef(false)
const highlighted = shallowRef<string | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
const shown = computed(() => expanded.value ? props.quotes : props.quotes.slice(0, 3))
watch(() => props.quotes.map(quote => quote.id), (ids, previous) => {
  if (!props.removable)
    return
  const added = ids.find(id => !previous.includes(id))
  if (added) {
    clearTimeout(timer)
    highlighted.value = added
    timer = setTimeout(() => highlighted.value = null, 1400)
    if (ids.indexOf(added) >= 3)
      expanded.value = true
  }
})
onBeforeUnmount(() => clearTimeout(timer))
function label(quote: BuddyResourceQuote) {
  if ('element' in quote)
    return `${quote.source.title} · ${new URL(quote.source.url).hostname || 'file'} · <${quote.element.tagName}>`
  const title = quote.source.kind === 'artifact' ? `${t('desktop.chat.turnOutputs')} · ${quote.source.title}` : quote.source.title
  return `${title}${quote.range ? ` · L${quote.range.startLineNumber}–${quote.range.endLineNumber}` : ''}`
}
async function locate(quote: BuddyResourceQuote) {
  if (!references || !await references.locate(quote))
    message.info(t('desktop.chat.resourceQuoteSourceUnavailable'))
}
</script>

<template>
  <div v-if="quotes.length" class="resource-quote-strip" data-quote-exclude>
    <div v-for="quote in shown" :key="quote.id" class="resource-quote-card" :class="{ 'is-highlighted': highlighted === quote.id }" :data-resource-quote-id="quote.id">
      <NPopover trigger="click" placement="top-start" :show-arrow="false">
        <template #trigger>
          <button type="button" class="resource-quote-card__preview" :aria-label="t('desktop.chat.resourceQuotePreview', { title: label(quote) })" @click.stop>
            <DesktopIcon :component="'element' in quote ? Globe20Regular : Document20Regular" class="resource-quote-card__icon" />
            <span class="resource-quote-card__body">
              <small :title="'element' in quote ? quote.source.url : quote.source.kind === 'file' ? quote.source.file.path : quote.source.path">{{ label(quote) }}</small>
              <span class="resource-quote-card__excerpt">{{ quote.text }}</span>
            </span>
          </button>
        </template>
        <section class="resource-quote-preview" :aria-label="t('desktop.chat.resourceQuotePreview', { title: label(quote) })">
          <header>{{ label(quote) }}</header>
          <p class="resource-quote-preview__path">
            {{ 'element' in quote ? quote.source.url : quote.source.kind === 'file' ? quote.source.file.path : quote.source.path }}
          </p>
          <pre>{{ quote.text }}</pre>
          <pre v-if="'element' in quote">{{ JSON.stringify(quote.element, null, 2) }}</pre>
          <NButton v-if="references" size="tiny" secondary @click="locate(quote)">
            {{ t('desktop.chat.resourceQuoteLocate') }}
          </NButton>
        </section>
      </NPopover>
      <NButton v-if="removable" class="buddy-icon-button resource-quote-card__remove" quaternary size="tiny" :disabled="disabled" :aria-label="t('desktop.chat.removeQuote')" @click="emit('remove', quote.id)">
        <template #icon>
          <DesktopIcon :component="Dismiss16Regular" />
        </template>
      </NButton>
    </div>
    <NButton v-if="quotes.length > 3" class="resource-quote-strip__more" size="tiny" quaternary @click="expanded = !expanded">
      {{ expanded ? t('desktop.chat.resourceQuoteCollapse') : t('desktop.chat.resourceQuoteMore', { count: quotes.length - 3 }) }}
    </NButton>
  </div>
</template>

<style scoped>
.resource-quote-strip { display: flex; flex-wrap: wrap; min-width: 0; max-width: 100%; gap: 8px; padding-bottom: 6px; max-height: 180px; overflow: auto; overscroll-behavior: contain; }
.resource-quote-card { display: flex; flex: 0 0 auto; width: 180px; max-width: 100%; min-width: 0; align-items: flex-start; border: 1px solid var(--buddy-border-subtle); border-radius: var(--buddy-radius-micro); background: var(--buddy-surface-raised); }
.resource-quote-card.is-highlighted { border-color: var(--buddy-accent-text); }
.resource-quote-card__preview { display: flex; flex: 1; gap: 8px; min-width: 0; padding: 8px 10px; border: 0; background: transparent; color: var(--buddy-text-primary); text-align: left; font: inherit; cursor: pointer; }
.resource-quote-card__preview:hover { background: var(--buddy-state-hover); }
.resource-quote-card__preview:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: -2px; border-radius: var(--buddy-radius-micro); }
.resource-quote-card__icon { flex: none; margin-top: 2px; color: var(--buddy-accent-text); }
.resource-quote-card__body { display: grid; min-width: 0; gap: 3px; }
.resource-quote-card__body small { color: var(--buddy-text-secondary); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.resource-quote-card__excerpt { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.5; }
.resource-quote-card__remove { flex: none; margin: 4px 4px 0 0; }
.resource-quote-strip__more { align-self: center; }
.resource-quote-preview { width: min(480px, calc(100vw - 48px)); max-width: 100%; color: var(--buddy-text-primary); }
.resource-quote-preview header { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.resource-quote-preview__path { font-size: 12px; color: var(--buddy-text-secondary); overflow-wrap: anywhere; margin: 4px 0 12px; }
.resource-quote-preview pre { max-height: min(360px, 45vh); overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--buddy-font-mono); font-size: 12px; line-height: 1.6; margin: 0 0 12px; user-select: text; }
</style>
