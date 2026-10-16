<script setup lang="ts">
import type { DocumentHistoryPanelProps } from './typing'
import { useI18n } from 'vue-i18n'
import { useDocumentHistoryPanel } from '../../composables/useDocumentHistoryPanel'

defineProps<DocumentHistoryPanelProps>()
const { t } = useI18n()
const {
  currentEntryTimeLabel,
  hasDocument,
  historySections,
  isCurrentEntrySelected,
  isEntrySelected,
  isGroupExpanded,
  resolveEntryDetail,
  selectCurrentEntry,
  selectEntry,
  toggleGroup,
} = useDocumentHistoryPanel()
</script>

<template>
  <aside class="document-history-panel flex w-full min-w-[var(--panel-docs-history-width)] max-w-[var(--panel-docs-history-width)] flex-col max-[1180px]:min-w-0 max-[1180px]:max-w-full">
    <div class="document-history-panel__header px-4 pb-[0.875rem] pt-[1.125rem]">
      <div class="text-base font-bold tracking-[0.01em] text-main">
        {{ t('docs.common.history') }}
      </div>
    </div>

    <div v-if="!hasDocument" class="px-4 py-4 text-[13px] leading-[1.6] text-secondary">
      {{ t('docs.history.noDocument') }}
    </div>

    <div v-else-if="isLoading" class="px-4 py-4 text-[13px] leading-[1.6] text-secondary">
      {{ t('docs.history.loading') }}
    </div>

    <div v-else class="flex-1 overflow-y-auto px-[0.875rem] pb-5 pt-4">
      <article
        class="document-history-panel__item mb-3.5 pl-2.5"
        :class="{ 'is-selected': isCurrentEntrySelected() }"
      >
        <button
          type="button"
          class="document-history-panel__item-button flex w-full flex-col gap-1.5 rounded-[0.875rem] border-0 px-[0.875rem] py-3 text-left"
          @click="selectCurrentEntry"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="document-history-panel__item-time text-[13px] font-semibold leading-[1.4]">
              {{ t('docs.common.currentContent') }}
            </div>
            <span class="document-history-panel__item-status inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold">
              {{ t('docs.history.editing') }}
            </span>
          </div>

          <div v-if="currentEntryTimeLabel" class="text-xs leading-6 text-secondary">
            {{ currentEntryTimeLabel }}
          </div>
        </button>
      </article>

      <div v-if="!historySections.length" class="px-3 pt-1 text-xs text-secondary">
        {{ t('docs.history.empty') }}
      </div>

      <section
        v-for="(section, sectionIndex) in historySections"
        :key="section.id"
        class="document-history-panel__section"
        :class="{ 'mt-4': sectionIndex > 0 }"
      >
        <div class="mb-2 text-xs font-semibold text-secondary">
          {{ section.label }}
        </div>

        <div class="flex flex-col gap-2">
          <div
            v-for="group in section.groups"
            :key="group.id"
            class="flex flex-col gap-1.5"
          >
            <button
              v-if="group.collapsible"
              type="button"
              class="document-history-panel__group-header flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent px-0 py-0.5 text-left text-xs text-secondary"
              @click="toggleGroup(group.id)"
            >
              <span
                class="document-history-panel__group-caret inline-flex w-3 items-center justify-center text-primary"
                :class="{ 'is-expanded': isGroupExpanded(group) }"
              >
                ▸
              </span>
              <span class="min-w-0 font-semibold">
                {{ group.label }}
              </span>
              <span class="ml-auto text-secondary">
                {{ t('docs.common.entries', { count: group.entries.length }) }}
              </span>
            </button>

            <div
              v-if="!group.collapsible || isGroupExpanded(group)"
              class="flex flex-col gap-1.5"
            >
              <article
                v-for="entry in group.entries"
                :key="entry.snapshotId"
                class="document-history-panel__item pl-2.5"
                :class="{ 'is-selected': isEntrySelected(entry) }"
              >
                <button
                  type="button"
                  class="document-history-panel__item-button flex w-full flex-col gap-1.5 rounded-[0.875rem] border-0 px-[0.875rem] py-3 text-left"
                  @click="selectEntry(entry.snapshotId)"
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="document-history-panel__item-time text-[13px] font-semibold leading-[1.4]">
                      {{ entry.timeLabel }}
                    </div>
                    <span
                      v-if="entry.isCurrentContent"
                      class="document-history-panel__item-status inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold"
                    >
                      {{ t('docs.common.currentContent') }}
                    </span>
                  </div>

                  <div
                    v-if="resolveEntryDetail(entry)"
                    class="text-xs leading-6 text-secondary"
                  >
                    {{ resolveEntryDetail(entry) }}
                  </div>

                  <div class="inline-flex items-center gap-1.5 text-xs text-secondary">
                    <span class="h-1.5 w-1.5 rounded-full bg-primary-a60" />
                    <span>{{ entry.userDisplayName }}</span>
                  </div>
                </button>
              </article>
            </div>
          </div>
        </div>
      </section>
    </div>
  </aside>
</template>

<style scoped lang="scss">
.document-history-panel {
  border-left: 1px solid color-mix(in srgb, var(--brand-border-base) 74%, transparent);
  background: color-mix(in srgb, var(--brand-bg-surface) 94%, var(--brand-bg-base));

  .document-history-panel__header {
    border-bottom: 1px solid color-mix(in srgb, var(--brand-border-base) 70%, transparent);
  }
  .document-history-panel__group-caret {
    color: color-mix(in srgb, var(--brand-primary) 78%, transparent);
    transition: transform 0.16s ease;

    &.is-expanded {
      transform: rotate(90deg);
    }
  }

  .document-history-panel__item {
    position: relative;

    &::before {
      content: '';
      position: absolute;
      top: 0.625rem;
      bottom: 0.625rem;
      left: 0;
      width: 2px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--brand-border-base) 68%, transparent);
      transition: background-color 0.16s ease;
    }

    &.is-selected::before {
      background: color-mix(in srgb, var(--brand-primary) 74%, var(--brand-border-base));
    }
  }

  .document-history-panel__item-button {
    border: 0;
    background: var(--brand-bg-surface);
    color: inherit;
    cursor: pointer;
    transition:
      background-color 0.16s ease,
      box-shadow 0.16s ease;

    &:hover {
      background: color-mix(in srgb, var(--brand-fill-light) 86%, var(--brand-bg-surface));
    }
  }

  .document-history-panel__item.is-selected .document-history-panel__item-button {
    background: color-mix(in srgb, var(--brand-primary) 7%, var(--brand-bg-surface));
    box-shadow: var(--brand-shadow-hairline);
  }

  .document-history-panel__item-time {
    color: var(--brand-text-primary);
  }

  .document-history-panel__item-status {
    background: color-mix(in srgb, var(--brand-primary) 8%, var(--brand-bg-surface));
    color: var(--brand-primary);
  }
}

@media (max-width: 1180px) {
  .document-history-panel {
    width: 100%;
    border-left: 0;
    border-top: 1px solid color-mix(in srgb, var(--brand-border-base) 80%, transparent);
  }
}
</style>
