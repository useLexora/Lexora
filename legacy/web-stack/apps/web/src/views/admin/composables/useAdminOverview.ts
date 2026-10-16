import type { SystemAdminOverview } from '@/apis/system-admin'
import { computed, onMounted, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { getSystemAdminOverview } from '@/apis/system-admin'
import { SvgIconCategory } from '@/components/svg-icon/typing'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

export function useAdminOverview() {
  const { t } = useI18n({ useScope: 'global' })
  const overview = shallowRef<SystemAdminOverview | null>(null)
  const errorMessage = shallowRef('')
  const isLoading = shallowRef(false)
  const metricCards = computed(() => {
    if (!overview.value) {
      return []
    }

    return [
      {
        label: t('admin.overview.totalUsers'),
        value: overview.value.totalUsers,
        detail: [
          t('admin.overview.activeUsers', { count: overview.value.activeUsers }),
          t('admin.overview.disabledUsers', { count: overview.value.disabledUsers }),
        ].join(', '),
        iconCategory: SvgIconCategory.UI,
        icon: 'user-group',
      },
      {
        label: t('admin.overview.systemAdmins'),
        value: overview.value.systemAdminCount,
        detail: t('admin.overview.systemAdminCountDetail'),
        iconCategory: SvgIconCategory.UI,
        icon: 'user-admin',
      },
      {
        label: t('admin.overview.totalDocuments'),
        value: overview.value.totalDocuments,
        detail: [
          t('admin.overview.publishedDocuments', { count: overview.value.publishedDocuments }),
          t('admin.overview.lockedDocuments', { count: overview.value.lockedDocuments }),
        ].join(', '),
        iconCategory: SvgIconCategory.UI,
        icon: 'document-view',
      },
    ]
  })

  async function loadOverview() {
    isLoading.value = true
    errorMessage.value = ''

    try {
      overview.value = await getSystemAdminOverview()
    }
    catch (error) {
      errorMessage.value = getRequestErrorDisplayMessage(error, t('admin.errors.loadOverview'))
    }
    finally {
      isLoading.value = false
    }
  }

  onMounted(loadOverview)

  return {
    overview,
    errorMessage,
    isLoading,
    loadOverview,
    metricCards,
  }
}
