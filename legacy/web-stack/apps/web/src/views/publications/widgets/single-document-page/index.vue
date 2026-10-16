<script setup lang="ts">
import type { PublicationSingleDocumentPageProps } from './typing'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { SvgIcon } from '@/components/svg-icon'
import dayjs from '@/utils/dayjs'
import PublicationDocumentContent from '../../components/document-content'

const props = defineProps<PublicationSingleDocumentPageProps>()
const { t } = useI18n()
const ownerName = computed(() => props.document.owner?.displayName || t('docs.publicReader.ownerFallback'))
const documentTitle = computed(() => props.document.title || t('docs.common.noTitle'))
const updatedAtText = computed(() => dayjs(props.document.updatedAt).format(t('docs.publicReader.updatedAtDate')))
</script>

<template>
  <section class="publication-single-document-page">
    <header class="publication-single-document-page__topbar">
      <div class="publication-single-document-page__titlebar">
        <div class="publication-single-document-page__breadcrumb">
          <span class="publication-single-document-page__owner">{{ ownerName }}</span>
          <SvgIcon category="ui" icon="chevron-right" size="12px" />
          <strong class="publication-single-document-page__title">{{ documentTitle }}</strong>
        </div>

        <p class="publication-single-document-page__time">
          {{ t('docs.publicReader.modifiedAt', { date: updatedAtText }) }}
        </p>
      </div>

      <p class="publication-single-document-page__auth-hint">
        <RouterLink :to="{ name: 'login' }" class="publication-single-document-page__auth-link">
          {{ t('docs.publicReader.authCtaBefore') }}
        </RouterLink>{{ t('docs.publicReader.authCtaAfter') }}
      </p>
    </header>

    <main class="publication-single-document-page__main">
      <PublicationDocumentContent
        :document="props.document"
        :body="props.body"
        layout="plain"
        :show-meta="false"
      />
    </main>
  </section>
</template>

<style scoped lang="scss">
.publication-single-document-page {
  min-height: 100vh;
  background: var(--publication-c-bg);
}

.publication-single-document-page__topbar {
  display: flex;
  min-height: 3.5rem;
  align-items: center;
  justify-content: space-between;
  gap: 1.25rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--publication-c-gutter);
  background: var(--publication-c-bg);
}

.publication-single-document-page__titlebar {
  display: grid;
  min-width: 0;
  gap: 0.0625rem;
}

.publication-single-document-page__breadcrumb {
  display: flex;
  min-width: 0;
  align-items: center;
  color: var(--publication-c-text-2);
  font-size: 0.8125rem;
  line-height: 1.35;
}

.publication-single-document-page__time {
  margin: 0;
  color: var(--publication-c-text-3);
  font-size: 0.75rem;
  line-height: 1.4;
  white-space: nowrap;
}

.publication-single-document-page__owner,
.publication-single-document-page__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.publication-single-document-page__owner {
  max-width: 8rem;
}

.publication-single-document-page__title {
  max-width: min(38rem, 48vw);
  color: var(--publication-c-text-1);
  font-weight: 700;
}

.publication-single-document-page__auth-hint {
  flex: 0 1 auto;
  margin: 0;
  color: var(--publication-c-text-3);
  font-size: 0.75rem;
  line-height: 1.5;
  text-align: right;
  white-space: nowrap;
}

.publication-single-document-page__auth-link {
  color: var(--publication-c-brand-1);
  font-weight: 500;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--publication-c-brand-1) 42%, transparent);
  text-underline-offset: 0.18em;

  &:hover,
  &:focus-visible {
    text-decoration-color: currentColor;
  }
}

.publication-single-document-page__main {
  display: flex;
  min-width: 0;
  justify-content: center;
  padding: 3rem 1.5rem 8rem;
}

@media (min-width: 640px) {
  .publication-single-document-page__topbar {
    padding-inline: 1.75rem;
  }

  .publication-single-document-page__main {
    padding: 4rem 2rem 8rem;
  }
}

@media (max-width: 560px) {
  .publication-single-document-page__topbar {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.25rem;
  }

  .publication-single-document-page__time,
  .publication-single-document-page__auth-hint {
    text-align: left;
    white-space: normal;
  }
}
</style>
