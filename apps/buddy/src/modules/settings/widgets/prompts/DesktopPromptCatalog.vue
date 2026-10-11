<script setup lang="ts">
import type { PromptEntry } from '../../model/promptCatalog'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { DocumentText20Regular, TextDescription20Regular } from '@vicons/fluent'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  entries: readonly PromptEntry[]
  selectedId: string
  language: BuddyLocale
}>()
const emit = defineEmits<{ select: [id: string] }>()
const { t } = useBuddyI18n(() => props.language)
const groups = computed(() => (['system', 'template'] as const).map(kind => ({
  kind,
  label: t(`desktop.prompts.group.${kind}`),
  entries: props.entries.filter(entry => entry.kind === kind),
})).filter(group => group.entries.length))
</script>

<template>
  <nav class="prompt-catalog min-w-0 overflow-auto py-[20px] px-[10px] border-r-1 border-r-solid border-r-border">
    <section v-for="group in groups" :key="group.kind" class="prompt-catalog__group">
      <h3>{{ group.label }}</h3>
      <div class="prompt-catalog__items grid gap-[4px]">
        <button
          v-for="item in group.entries"
          :key="item.id"
          type="button"
          class="prompt-catalog__item flex items-center gap-[8px] w-full py-[8px] px-[10px] border-0 rounded-[6px] bg-transparent text-muted text-left cursor-pointer hover:bg-hover ui-focus-ring"
          :class="{ 'is-selected': selectedId === item.id }"
          :aria-current="selectedId === item.id ? 'true' : undefined"
          @click="emit('select', item.id)"
        >
          <DesktopIcon :component="group.kind === 'template' ? DocumentText20Regular : TextDescription20Regular" />
          <span class="prompt-catalog__title min-w-0 text-[13px] leading-[20px]">{{ item.title }}</span>
          <span v-if="item.command" class="ml-auto text-muted text-[11px] leading-[16px]">{{ item.command }}</span>
        </button>
      </div>
    </section>
  </nav>
</template>

<style scoped lang="scss">
.prompt-catalog { flex: 0 0 204px; scrollbar-width: thin; scrollbar-color: var(--buddy-border-strong) transparent; }
.prompt-catalog__group + .prompt-catalog__group { margin-top: 24px; }
.prompt-catalog__group h3 { margin: 0 10px 8px; color: var(--buddy-text-muted); font-size: 11px; font-weight: 500; }
.prompt-catalog__item > :first-child { flex: none; }
.prompt-catalog__item.is-selected { background: var(--buddy-nav-selected); color: var(--buddy-nav-foreground); }
.is-selected .prompt-catalog__title { font-weight: 600; }

@container (max-width: 720px) {
  .prompt-catalog { flex: none; max-height: 38%; padding: 12px 16px; border-right: 0; border-bottom: 1px solid var(--buddy-border-subtle); }
  .prompt-catalog__group { display: flex; align-items: flex-start; gap: 10px; }
  .prompt-catalog__group + .prompt-catalog__group { margin-top: 6px; }
  .prompt-catalog__group h3 { flex: 0 0 68px; margin: 7px 0 0; line-height: 18px; }
  .prompt-catalog__items { display: flex; flex: 1; min-width: 0; flex-wrap: wrap; }
  .prompt-catalog__item { width: auto; gap: 6px; padding: 6px 8px; }
}
</style>
