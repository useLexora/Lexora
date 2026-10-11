<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { presentChatToolSearch } from '../../model/transcript/chatToolText'

const props = defineProps<{ output: string, toolName: string, language: BuddyLocale }>()
const { t } = useBuddyI18n(() => props.language)
const limit = shallowRef(200)
const content = computed(() => presentChatToolSearch(props.output, props.toolName, limit.value))
watch(() => props.toolName, () => limit.value = 200)
</script>

<template>
  <div class="buddy-chat-tool-search">
    <div class="max-h-60 overflow-auto pt-0 pr-0 pb-[8px] pl-0">
      <template v-for="(block, index) in content.blocks" :key="index">
        <section v-if="block.kind === 'file'" class="min-w-max">
          <header class="buddy-chat-tool-search__path sticky top-0 py-[6px] px-[10px] bg-subtle text-muted font-mono text-[length:var(--buddy-chat-caption-font-size)]">
            {{ block.path }}
          </header>
          <div v-for="(line, lineIndex) in block.lines" :key="lineIndex" class="buddy-chat-tool-search__line flex gap-[12px] py-0 px-[10px] text-muted font-mono text-[length:var(--buddy-chat-code-font-size)] leading-[var(--buddy-chat-code-line-height)]" :class="{ 'is-match': line.match }">
            <span class="buddy-chat-tool-search__number flex-none text-muted text-right">{{ line.number }}</span>
            <code>{{ line.text }}</code>
          </div>
        </section>
        <pre v-else-if="block.text" class="buddy-chat-tool-search__text m-0 py-[4px] px-[10px] whitespace-pre-wrap [overflow-wrap:anywhere]">{{ block.text }}</pre>
      </template>
    </div>
    <button v-if="content.remaining" class="buddy-chat-tool-search__more mt-0 mr-[4px] mb-[4px] ml-[4px] py-[4px] px-[6px] border-0 rounded-micro bg-transparent text-muted text-[length:var(--buddy-chat-caption-font-size)] cursor-pointer hover:text-fg hover:bg-hover focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]" type="button" @click="limit += 200">
      {{ t('desktop.chat.processToolMoreLines', { count: content.remaining }) }}
    </button>
  </div>
</template>

<style scoped lang="scss">
.buddy-chat-tool-search__path {
  white-space: pre;
}

.buddy-chat-tool-search__line {
  white-space: pre;
}

.buddy-chat-tool-search__number { min-width: 4ch; font-variant-numeric: tabular-nums; }
.buddy-chat-tool-search__line.is-match { color: var(--buddy-chat-code-color); }
.buddy-chat-tool-search__line.is-match .buddy-chat-tool-search__number { color: var(--buddy-text-secondary); }
.buddy-chat-tool-search__line code { font: inherit; }
.buddy-chat-tool-search__text { color: var(--buddy-chat-code-color); font: var(--buddy-chat-code-font-size) / var(--buddy-chat-code-line-height) var(--buddy-font-mono); }
</style>
