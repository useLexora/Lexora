<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import PagePanel from '@/layouts/panels/page-panel'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import AuthGovernancePanel from '../../components/auth-governance-panel'
import AdminPageHeader from '../../components/page-header'
import UserTable from '../../components/user-table'
import { useAdminAuthGovernance } from '../../composables/useAdminAuthGovernance'
import { useAdminUsers } from '../../composables/useAdminUsers'

const { errorMessage: usersErrorMessage, loadUsers } = useAdminUsers()
const { errorMessage: governanceErrorMessage, loadGovernance } = useAdminAuthGovernance()
const { t } = useI18n({ useScope: 'global' })

const isLoading = shallowRef(false)
const pageErrorMessage = shallowRef('')
const errorMessage = computed(() =>
  pageErrorMessage.value
  || usersErrorMessage.value
  || governanceErrorMessage.value,
)

onMounted(loadData)

async function loadData() {
  isLoading.value = true
  pageErrorMessage.value = ''
  usersErrorMessage.value = ''
  governanceErrorMessage.value = ''

  try {
    await Promise.all([
      loadUsers(),
      loadGovernance(),
    ])
  }
  catch (error) {
    pageErrorMessage.value = getRequestErrorDisplayMessage(error, t('admin.errors.loadUserManagement'))
  }
  finally {
    isLoading.value = false
  }
}
</script>

<template>
  <PagePanel>
    <template #header>
      <AdminPageHeader :title="t('admin.pages.users')" />
    </template>

    <div class="admin-users min-h-full flex flex-col gap-6 bg-fill-lighter p-4 lg:p-6">
      <ElAlert v-if="errorMessage" :title="errorMessage" type="error" show-icon :closable="false" class="rounded-xl" />

      <ElSkeleton v-else-if="isLoading" animated class="grid gap-6">
        <template #template>
          <section class="rounded-lg border border-border-a60 bg-surface p-5">
            <div class="mb-5 flex items-center justify-between gap-4">
              <div class="grid min-w-0 flex-1 gap-2">
                <ElSkeletonItem variant="h3" class="max-w-40" />
                <ElSkeletonItem variant="text" class="max-w-72" />
              </div>
              <ElSkeletonItem variant="button" class="h-8 max-w-24" />
            </div>
            <div class="grid gap-3 md:grid-cols-2">
              <ElSkeletonItem variant="rect" class="h-11 w-full" />
              <ElSkeletonItem variant="rect" class="h-11 w-full" />
            </div>
          </section>

          <section class="overflow-hidden rounded-lg border border-border-a60 bg-surface">
            <div class="flex items-center justify-between gap-3 border-b border-border-a60 px-5 py-4">
              <ElSkeletonItem variant="rect" class="h-8 max-w-96" />
              <ElSkeletonItem variant="button" class="h-8 max-w-20" />
            </div>
            <div class="grid gap-3 p-5">
              <ElSkeletonItem v-for="row in 6" :key="row" variant="rect" class="h-10 w-full" />
            </div>
          </section>
        </template>
      </ElSkeleton>

      <template v-else>
        <AuthGovernancePanel />
        <UserTable />
      </template>
    </div>
  </PagePanel>
</template>
