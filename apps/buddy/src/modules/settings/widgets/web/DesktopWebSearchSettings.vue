<script setup lang="ts">
import type { WebSearchProvider, WebSearchSource } from '@buddy-shared/network/webProtocol'
import type { DragEndEvent } from '@dnd-kit/vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { RestrictToVerticalAxis } from '@dnd-kit/abstract/modifiers'
import { DragDropProvider } from '@dnd-kit/vue'
import { isSortable } from '@dnd-kit/vue/sortable'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopWebSearchSource from './DesktopWebSearchSource.vue'

const props = defineProps<{ sources: readonly Readonly<WebSearchSource>[], disabled: boolean, language: BuddyLocale }>()
const emit = defineEmits<{
  toggle: [provider: WebSearchProvider, enabled: boolean]
  reorder: [provider: WebSearchProvider, target: WebSearchProvider, position: 'before' | 'after']
}>()
const { t } = useBuddyI18n(() => props.language)

function dragEnd(event: DragEndEvent) {
  if (event.canceled || props.disabled)
    return
  const { source } = event.operation
  if (!isSortable(source) || source.initialIndex === source.index)
    return
  const from = props.sources[source.initialIndex]
  const target = props.sources[source.index]
  if (from && target)
    emit('reorder', from.provider, target.provider, source.index < source.initialIndex ? 'before' : 'after')
}
</script>

<template>
  <section class="desktop-web-search grid gap-[0.8rem]">
    <header class="grid gap-[0.3rem]">
      <h2 class="m-0 text-[0.92rem] font-600">
        {{ t('desktop.web.search') }}
      </h2>
      <p class="m-0 text-muted text-[0.75rem] leading-[1.65]">
        {{ t('desktop.web.searchOrderDescription') }}
      </p>
      <span id="web-search-order-help" class="desktop-web-search__keyboard-help absolute w-[1px] h-[1px] overflow-hidden whitespace-nowrap">{{ t('desktop.web.searchKeyboardHelp') }}</span>
    </header>
    <DragDropProvider :modifiers="[RestrictToVerticalAxis]" @drag-end="dragEnd">
      <ol class="desktop-web-search__list m-0 p-0 border-1 border-solid border-border rounded-[0.65rem]">
        <DesktopWebSearchSource v-for="(source, index) in sources" :key="source.provider" :source="source" :index="index" :disabled="disabled" :language="language" @toggle="emit('toggle', source.provider, $event)" />
      </ol>
    </DragDropProvider>
  </section>
</template>

<style scoped lang="scss">
.desktop-web-search__keyboard-help { clip-path: inset(50%); }
.desktop-web-search__list { list-style: none; }
</style>
