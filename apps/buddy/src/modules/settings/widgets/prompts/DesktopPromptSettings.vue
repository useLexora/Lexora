<script setup lang="ts">
import type { BuiltinPromptCatalog } from '@buddy-shared/prompts/promptApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed, ref } from 'vue'
import { createBuiltinPromptEntries } from '../../model/promptCatalog'
import DesktopPromptCatalog from './DesktopPromptCatalog.vue'
import DesktopPromptDetail from './DesktopPromptDetail.vue'

const props = defineProps<{
  catalog: BuiltinPromptCatalog
  language: BuddyLocale
  writeClipboardText: (text: string) => Promise<void>
}>()
const selectedId = ref('system')
const selectedVariants = ref<Record<string, string>>({})
const entries = computed(() => createBuiltinPromptEntries(props.catalog, props.language))
const entry = computed(() => entries.value.find(entry => entry.id === selectedId.value) ?? entries.value[0]!)
const variant = computed(() => entry.value.variants.find(variant => variant.id === (selectedVariants.value[entry.value.id] ?? entry.value.defaultVariantId)) ?? entry.value.variants[0]!)
</script>

<template>
  <section class="prompt-settings">
    <DesktopPromptCatalog
      :entries="entries"
      :selected-id="entry.id"
      :language="language"
      @select="selectedId = $event"
    />
    <DesktopPromptDetail
      :entry="entry"
      :variant="variant"
      :language="language"
      :write-clipboard-text="writeClipboardText"
      @select-variant="selectedVariants[entry.id] = $event"
    />
  </section>
</template>

<style scoped>
.prompt-settings { display: flex; flex: 1; min-width: 0; min-height: 0; }
@container (max-width: 720px) {
  .prompt-settings { flex-direction: column; }
}
</style>
