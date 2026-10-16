<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Empty from '@/components/empty'
import PagePanel from '@/layouts/panels/page-panel'

const { t } = useI18n()
</script>

<template>
  <PagePanel>
    <template #header>
      <div class="schedule-view-context">
        <div class="schedule-view-context__title text-2xl font-semibold leading-8 text-main">
          {{ t('placeholderPages.schedule') }}
        </div>
      </div>
    </template>

    <section class="schedule-view__empty box-border flex min-h-full items-center justify-center px-6 py-12">
      <Empty :title="t('placeholderPages.scheduleComingSoon')" description="" />
    </section>
  </PagePanel>
</template>
