<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Empty from '@/components/empty'
import PagePanel from '@/layouts/panels/page-panel'

const { t } = useI18n()
</script>

<template>
  <PagePanel>
    <template #header>
      <div class="code-view-context">
        <div class="code-view-context__title text-2xl font-semibold leading-8 text-main">
          {{ t('placeholderPages.code') }}
        </div>
      </div>
    </template>

    <section class="code-view__empty box-border flex min-h-full items-center justify-center px-6 py-12">
      <Empty :title="t('placeholderPages.codeComingSoon')" description="" />
    </section>
  </PagePanel>
</template>
