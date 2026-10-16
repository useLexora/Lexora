<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import PagePanel from '@/layouts/panels/page-panel'
import AdminMetricCard from '../../components/metric-card'
import AdminPageHeader from '../../components/page-header'
import { useAdminOverview } from '../../composables/useAdminOverview'

const { overview, errorMessage, isLoading, metricCards } = useAdminOverview()
const { t } = useI18n({ useScope: 'global' })
</script>

<template>
  <PagePanel>
    <template #header>
      <AdminPageHeader :title="t('admin.pages.overview')" />
    </template>

    <div class="admin-overview min-h-full bg-fill-lighter p-4 lg:p-6">
      <ElAlert v-if="errorMessage" :title="errorMessage" type="error" show-icon :closable="false" class="rounded-xl" />

      <ElSkeleton v-else-if="isLoading" animated>
        <template #template>
          <section class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div v-for="card in 3" :key="card" class="rounded-lg border border-border-a60 bg-surface p-5">
              <div class="mb-4 flex items-center justify-between gap-4">
                <div class="grid min-w-0 flex-1 gap-2">
                  <ElSkeletonItem variant="text" class="max-w-28" />
                  <ElSkeletonItem variant="h3" class="max-w-36" />
                </div>
                <ElSkeletonItem variant="circle" class="h-10 w-10 shrink-0" />
              </div>
              <ElSkeletonItem variant="text" class="max-w-48" />
            </div>
          </section>
        </template>
      </ElSkeleton>

      <div v-else-if="overview" class="flex flex-col gap-6">
        <section class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AdminMetricCard
            v-for="card in metricCards"
            :key="card.label"
            :detail="card.detail"
            :label="card.label"
            :value="card.value"
            :icon-category="card.iconCategory"
            :icon="card.icon"
          />
        </section>
      </div>
    </div>
  </PagePanel>
</template>
