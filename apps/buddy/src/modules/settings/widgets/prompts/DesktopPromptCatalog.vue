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
  <nav class="prompt-catalog">
    <section v-for="group in groups" :key="group.kind" class="prompt-catalog__group">
      <h3>{{ group.label }}</h3>
      <div class="prompt-catalog__items">
        <button
          v-for="item in group.entries"
          :key="item.id"
          type="button"
          class="prompt-catalog__item"
          :class="{ 'is-selected': selectedId === item.id }"
          :aria-current="selectedId === item.id ? 'true' : undefined"
          @click="emit('select', item.id)"
        >
          <DesktopIcon :component="group.kind === 'template' ? DocumentText20Regular : TextDescription20Regular" />
          <span class="prompt-catalog__title">{{ item.title }}</span>
          <span v-if="item.command" class="prompt-catalog__command">{{ item.command }}</span>
        </button>
      </div>
    </section>
  </nav>
</template>

<style scoped>
.prompt-catalog { flex: 0 0 204px; min-width: 0; overflow: auto; padding: 20px 10px; border-right: 1px solid var(--buddy-border-subtle); scrollbar-width: thin; scrollbar-color: var(--buddy-border-strong) transparent; }
.prompt-catalog__group + .prompt-catalog__group { margin-top: 24px; }
.prompt-catalog__group h3 { margin: 0 10px 8px; color: var(--buddy-text-muted); font-size: 11px; font-weight: 500; }
.prompt-catalog__items { display: grid; gap: 4px; }
.prompt-catalog__item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--buddy-text-secondary); text-align: left; cursor: pointer; }
.prompt-catalog__item > :first-child { flex: none; }
.prompt-catalog__item:hover { background: var(--buddy-state-hover); }
.prompt-catalog__item.is-selected { background: var(--buddy-nav-selected); color: var(--buddy-nav-foreground); }
.prompt-catalog__item:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: -2px; }
.prompt-catalog__title { min-width: 0; font-size: 13px; line-height: 20px; }
.is-selected .prompt-catalog__title { font-weight: 600; }
.prompt-catalog__command { margin-left: auto; color: var(--buddy-text-muted); font-size: 11px; line-height: 16px; }
@container (max-width: 720px) {
  .prompt-catalog { flex: none; max-height: 38%; padding: 12px 16px; border-right: 0; border-bottom: 1px solid var(--buddy-border-subtle); }
  .prompt-catalog__group { display: flex; align-items: flex-start; gap: 10px; }
  .prompt-catalog__group + .prompt-catalog__group { margin-top: 6px; }
  .prompt-catalog__group h3 { flex: 0 0 68px; margin: 7px 0 0; line-height: 18px; }
  .prompt-catalog__items { display: flex; flex: 1; min-width: 0; flex-wrap: wrap; }
  .prompt-catalog__item { width: auto; gap: 6px; padding: 6px 8px; }
}
</style>
