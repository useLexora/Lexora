<script setup lang="ts">
import type { Editor } from '@tiptap/core'
import type { TiptapEditorContent } from '../../core/typing'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { SvgIcon } from '@/components/svg-icon'
import { useEditorOutline } from './useEditorOutline'

const props = withDefaults(defineProps<{
  editor: Editor
  content: TiptapEditorContent
  defaultExpanded?: boolean
  mode?: 'hover' | 'manual'
  placement?: 'left' | 'right'
  showSearch?: boolean
  surface?: 'card' | 'transparent'
}>(), {
  defaultExpanded: false,
  mode: 'hover',
  placement: 'left',
  showSearch: true,
  surface: 'card',
})
const { t } = useI18n()
const {
  getBlockHref,
  getSearchResultText,
  getHeadingText,
  handleSearchKeydown,
  isActiveOutlineBlock,
  isExpanded,
  isSearchResultSelected,
  outline,
  resolveOutlineIndicatorWidth,
  resolveOutlineIndent,
  searchQuery,
  searchResults,
  selectBlock,
  setSelectedSearchIndex,
  setExpanded,
  updateSearchQuery,
} = useEditorOutline({
  defaultExpanded: props.defaultExpanded,
  editor: props.editor,
  getContent: () => props.content,
})

const isManualMode = computed(() => props.mode === 'manual')
const rootClass = computed(() => [
  `editor-outline--${props.placement}`,
  `editor-outline--${props.mode}`,
  `editor-outline--surface-${props.surface}`,
  {
    'is-expanded': isExpanded.value,
  },
])

function handleMouseEnter() {
  if (props.mode === 'hover') {
    setExpanded(true)
  }
}

function handleMouseLeave() {
  if (props.mode === 'hover') {
    setExpanded(false)
  }
}

function toggleExpanded() {
  setExpanded(!isExpanded.value)
}
</script>

<template>
  <aside
    v-if="outline.length"
    class="editor-outline"
    :class="rootClass"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <section v-if="isExpanded" class="editor-outline__panel">
      <div v-if="!props.showSearch || isManualMode" class="editor-outline__panel-header">
        <span>{{ t('editor.outline.outline') }}</span>
      </div>

      <ElInput
        v-if="props.showSearch"
        class="editor-outline__search-input"
        :model-value="searchQuery"
        clearable
        :placeholder="t('editor.outline.search')"
        @update:model-value="updateSearchQuery"
        @keydown="handleSearchKeydown"
      />

      <section v-if="props.showSearch && searchQuery.trim()" class="editor-outline__section">
        <div class="editor-outline__section-title">
          {{ t('editor.outline.searchResults') }}
        </div>

        <ul v-if="searchResults.length" class="editor-outline__result-list">
          <li
            v-for="(item, index) in searchResults"
            :key="item.blockId"
            class="editor-outline__item editor-outline__search-item"
            :class="{ 'is-active': isSearchResultSelected(item.blockId) }"
            @mouseenter="setSelectedSearchIndex(index)"
          >
            <div class="editor-outline__item-row">
              <a
                class="editor-outline__item-link"
                :href="getBlockHref(item.blockId)"
                @click.prevent="selectBlock(item.blockId)"
              >
                <span class="editor-outline__item-text">
                  {{ getSearchResultText(item.plainText) }}
                </span>
              </a>
            </div>
          </li>
        </ul>

        <div v-else class="editor-outline__empty">
          {{ t('editor.outline.emptySearch') }}
        </div>
      </section>

      <section class="editor-outline__section">
        <div v-if="props.showSearch" class="editor-outline__section-title">
          {{ t('editor.outline.outline') }}
        </div>

        <ol class="editor-outline__outline-list">
          <li
            v-for="item in outline"
            :key="item.blockId"
            class="editor-outline__item editor-outline__outline-item"
            :class="{ 'is-active': isActiveOutlineBlock(item.blockId) }"
            :data-heading-level="item.headingLevel"
            :style="{ '--editor-outline-indent': resolveOutlineIndent(item.headingLevel) }"
          >
            <div class="editor-outline__item-row">
              <a
                class="editor-outline__item-link"
                :href="getBlockHref(item.blockId)"
                :aria-current="isActiveOutlineBlock(item.blockId) ? 'true' : undefined"
                @click.prevent="selectBlock(item.blockId)"
              >
                <span class="editor-outline__item-text">
                  {{ getHeadingText(item) }}
                </span>
              </a>
            </div>
          </li>
        </ol>
      </section>
    </section>

    <button
      v-if="isManualMode && !isExpanded"
      type="button"
      class="editor-outline__manual-toggle"
      :aria-label="t('editor.outline.expand')"
      @click="toggleExpanded"
    >
      <SvgIcon category="ui" icon="sidebar-open" size="1rem" />
    </button>

    <ol v-if="!isManualMode || !isExpanded" class="editor-outline__rail">
      <li
        v-for="item in outline"
        :key="item.blockId"
        class="editor-outline__indicator"
        :class="{ 'is-active': isActiveOutlineBlock(item.blockId) }"
      >
        <a
          class="editor-outline__indicator-link"
          :href="getBlockHref(item.blockId)"
          @click.prevent="selectBlock(item.blockId)"
        >
          <span
            class="editor-outline__indicator-line"
            :style="{ width: resolveOutlineIndicatorWidth(item.headingLevel) }"
          />
        </a>
      </li>
    </ol>
  </aside>
</template>

<style scoped lang="scss">
.editor-outline {
  position: sticky;
  top: 1rem;
  z-index: 5;
  grid-area: 1 / 1;
  display: flex;
  justify-self: end;
  align-self: start;
  width: max-content;
  align-items: flex-start;
  gap: 0.5rem;
  pointer-events: auto;

  &--right {
    justify-self: end;
  }

  &--manual {
    top: 1.25rem;
  }

  &--manual.editor-outline--right {
    width: 100%;
    justify-self: stretch;
  }

  &__panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.625rem;
    padding: 0.125rem 0.25rem;
    color: var(--brand-text-primary);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.5;
  }

  &__manual-toggle {
    display: inline-grid;
    width: 1.625rem;
    height: 1.625rem;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--brand-text-tertiary);
    cursor: pointer;

    &:hover,
    &:focus-visible {
      background: color-mix(in srgb, var(--brand-primary) 8%, transparent);
      color: var(--brand-primary);
    }
  }

  &__manual-toggle {
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
    background: color-mix(in srgb, white 94%, var(--brand-bg-surface) 6%);
    box-shadow: var(--brand-shadow-hairline);
  }

  &__rail {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.375rem;
    margin: 0;
    padding-top: 0.125rem;
    padding-left: 0;
    list-style: none;
  }

  &__indicator {
    display: flex;
    justify-content: flex-end;
    width: 22px;
  }

  &__indicator-link {
    display: flex;
    justify-content: flex-end;
    width: 100%;
  }

  &__panel {
    display: grid;
    gap: 0.25rem;
    min-width: 9rem;
    width: max-content;
    max-width: 14rem;
    padding: 0.625rem;
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
    border-radius: 0.625rem;
    background: color-mix(in srgb, white 94%, var(--brand-bg-surface) 6%);
    box-shadow: var(--brand-shadow-floating);
    opacity: 0;
    transform: translateX(10px);
    pointer-events: none;
    transition: opacity 0.18s ease, transform 0.18s ease;
  }

  &__search-input {
    margin-bottom: 0.25rem;

    :deep(.el-input__wrapper) {
      background: color-mix(in srgb, white 88%, var(--brand-bg-surface) 12%);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand-border-base) 74%, transparent) inset;
    }

    :deep(.el-input__inner) {
      font-size: 13px;
      line-height: 1.4;
    }
  }

  &__section {
    display: grid;
    gap: 0.25rem;
  }

  &__section-title {
    padding: 0.125rem 0.25rem;
    color: var(--brand-text-secondary);
    font-size: 12px;
    font-weight: 600;
  }

  &__result-list {
    display: grid;
    gap: 0.25rem;
    margin: 0;
    padding-left: 0;
    list-style: none;
  }

  &__outline-list {
    display: grid;
    gap: 0.25rem;
    margin: 0;
    padding-left: 0;
    list-style: none;
  }

  &__item {
    --editor-outline-indent: 0rem;
    min-width: 0;
    border-radius: 0.375rem;
    color: color-mix(in srgb, var(--brand-text-primary) 78%, transparent);
    transition: background-color 0.16s ease, color 0.16s ease;
  }

  &__item-row {
    display: flex;
    align-items: stretch;
    gap: 0.125rem;
    min-width: 0;
  }

  &__item-link {
    display: flex;
    align-items: center;
    flex: 1;
    width: 100%;
    min-width: 0;
    padding: 0.5rem;
    padding-inline-start: calc(0.5rem + var(--editor-outline-indent));
    color: inherit;
    text-align: left;
    text-decoration: none;
    border-radius: inherit;

    &:hover,
    &:focus-visible {
      background: color-mix(in srgb, var(--brand-primary) 10%, white);
      color: var(--brand-text-primary);
    }
  }

  &__indicator-line {
    display: block;
    height: 2px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--brand-text-secondary) 22%, transparent);
    transition: background-color 0.16s ease;
  }

  &__item-text {
    overflow: hidden;
    color: inherit;
    font-size: 13px;
    line-height: 1.4;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__empty {
    padding: 0.125rem 0.25rem;
    color: var(--brand-text-secondary);
    font-size: 12px;
    line-height: 1.5;
  }

  &__indicator.is-active .editor-outline__indicator-line {
    background: color-mix(in srgb, var(--brand-primary) 78%, white);
  }

  &__item.is-active {
    background: color-mix(in srgb, var(--brand-primary) 10%, white);
    color: var(--brand-text-primary);
  }

  &__panel {
    opacity: 1;
    transform: translateX(0);
    pointer-events: auto;
  }

  &--manual &__panel {
    width: 100%;
    min-width: 12rem;
    max-width: 15rem;
  }

  &--surface-transparent {
    .editor-outline__panel {
      gap: 0.5rem;
      width: 100%;
      min-width: 12rem;
      max-width: 15rem;
      padding: 0.25rem 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
    }

    .editor-outline__panel-header {
      padding: 0;
      color: var(--brand-text-secondary);
      font-size: 13px;
      font-weight: 600;
    }

    .editor-outline__outline-list {
      gap: 0.25rem;
    }

    .editor-outline__item {
      border-radius: 0.375rem;
      color: color-mix(in srgb, var(--brand-text-secondary) 86%, transparent);
    }

    .editor-outline__item-link {
      padding: 0.5rem 0.25rem;
      padding-inline-start: calc(0.25rem + var(--editor-outline-indent));

      &:hover,
      &:focus-visible {
        background: transparent;
        color: var(--brand-text-primary);
      }
    }

    .editor-outline__item-text {
      font-size: 14px;
      line-height: 1.45;
    }

    .editor-outline__item.is-active {
      background: color-mix(in srgb, var(--brand-primary) 9%, transparent);
      color: var(--brand-text-primary);
    }
  }
}
</style>
