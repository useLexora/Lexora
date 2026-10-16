import type { TiptapJsonContent } from '@haohaoxue/lexora-contracts'
import type { FormInstance, FormRules } from 'element-plus'
import type {
  PlatformNotification,
  PlatformNotificationStatus,
} from '@/apis/notification'
import type {
  TiptapEditorResolveImageSrc,
  TiptapEditorUploadedImage,
} from '@/components/tiptap-editor/content/typing'
import {
  PLATFORM_NOTIFICATION_IMAGE_MAX_BYTES,
  PLATFORM_NOTIFICATION_STATUS,
  PLATFORM_NOTIFICATION_STATUS_VALUES,
  PLATFORM_NOTIFICATION_TITLE_MAX_LENGTH,
} from '@haohaoxue/lexora-contracts/notification'
import { prettyBytes } from '@haohaoxue/lexora-shared/file'
import { createEmptyTiptapContent } from '@haohaoxue/lexora-shared/tiptap'
import { computed, onMounted, reactive, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  createPlatformNotification,
  deletePlatformNotification,
  listPlatformNotifications,
  resolvePlatformNotificationAssets,
  updatePlatformNotification,
  uploadPlatformNotificationImage,
} from '@/apis/notification'
import { ElMessage, ElMessageBox } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

type NotificationDrawerMode = 'create' | 'edit' | 'view'
type NotificationStatusFilter = PlatformNotificationStatus | ''
export interface AdminNotificationForm {
  title: string
  content: TiptapJsonContent
}

const PLATFORM_NOTIFICATION_IMAGE_SIZE_LIMIT_LABEL = prettyBytes(PLATFORM_NOTIFICATION_IMAGE_MAX_BYTES)

export function useAdminNotifications() {
  const { t } = useI18n({ useScope: 'global' })
  const notifications = shallowRef<PlatformNotification[]>([])
  const total = shallowRef(0)
  const errorMessage = shallowRef('')
  const isLoading = shallowRef(false)
  const isSaving = shallowRef(false)
  const deletingNotificationId = shallowRef('')
  const formRef = shallowRef<FormInstance | null>(null)
  const drawerVisible = shallowRef(false)
  const drawerMode = shallowRef<NotificationDrawerMode>('create')
  const currentNotificationId = shallowRef('')
  const query = reactive({
    pageNo: 1,
    pageSize: 20,
    status: '' as NotificationStatusFilter,
  })
  const form = reactive<AdminNotificationForm>({
    title: '',
    content: createEmptyTiptapContent() as TiptapJsonContent,
  })
  const imageSrcCache = new Map<string, Promise<string | null>>()
  const formRules: FormRules<typeof form> = {
    title: [
      { required: true, message: t('admin.notifications.titleRequired'), trigger: 'blur' },
      { max: PLATFORM_NOTIFICATION_TITLE_MAX_LENGTH, message: t('admin.notifications.titleTooLong', { max: PLATFORM_NOTIFICATION_TITLE_MAX_LENGTH }), trigger: 'blur' },
    ],
  }
  const statusOptions = computed(() => [
    { label: t('admin.notifications.all'), value: '' },
    ...PLATFORM_NOTIFICATION_STATUS_VALUES.map(status => ({
      label: getStatusLabel(status),
      value: status,
    })),
  ])

  const drawerTitle = computed(() => {
    if (drawerMode.value === 'create') {
      return t('admin.notifications.createTitle')
    }

    if (drawerMode.value === 'view') {
      return t('admin.notifications.viewTitle')
    }

    return t('admin.notifications.editTitle')
  })
  const isEditing = computed(() => drawerMode.value === 'edit')
  const isViewing = computed(() => drawerMode.value === 'view')

  async function loadNotifications() {
    isLoading.value = true
    errorMessage.value = ''

    try {
      const response = await listPlatformNotifications({
        pageNo: query.pageNo,
        pageSize: query.pageSize,
        status: query.status || undefined,
      })

      notifications.value = response.items
      total.value = response.total
    }
    catch (error) {
      errorMessage.value = getRequestErrorDisplayMessage(error, t('admin.errors.loadNotifications'))
    }
    finally {
      isLoading.value = false
    }
  }

  function openCreateDrawer() {
    drawerMode.value = 'create'
    currentNotificationId.value = ''
    resetForm()
    drawerVisible.value = true
  }

  function openEditDrawer(notification: PlatformNotification) {
    if (notification.status === PLATFORM_NOTIFICATION_STATUS.PUBLISHED) {
      openViewDrawer(notification)
      return
    }

    drawerMode.value = 'edit'
    currentNotificationId.value = notification.id
    syncForm(notification)
    drawerVisible.value = true
  }

  function openViewDrawer(notification: PlatformNotification) {
    drawerMode.value = 'view'
    currentNotificationId.value = notification.id
    syncForm(notification)
    drawerVisible.value = true
  }

  function closeDrawer() {
    drawerVisible.value = false
  }

  function updateContent(content: TiptapJsonContent) {
    form.content = content
  }

  function updateTitle(title: string) {
    form.title = title
  }

  function setFormRef(instance: FormInstance | null) {
    formRef.value = instance
  }

  function getStatusLabel(status: PlatformNotificationStatus) {
    return status === PLATFORM_NOTIFICATION_STATUS.PUBLISHED
      ? t('admin.notifications.publishedStatus')
      : t('admin.notifications.draft')
  }

  async function saveDraft() {
    await saveNotification(PLATFORM_NOTIFICATION_STATUS.DRAFT)
  }

  async function publishNotification() {
    await saveNotification(PLATFORM_NOTIFICATION_STATUS.PUBLISHED)
  }

  async function saveNotification(status: PlatformNotificationStatus) {
    if (drawerMode.value === 'view') {
      return
    }

    form.title = form.title.trim()
    const isValid = await formRef.value?.validate().catch(() => false)

    if (!isValid) {
      return
    }

    isSaving.value = true

    try {
      if (drawerMode.value === 'create') {
        await createPlatformNotification({
          title: form.title,
          content: form.content,
          status,
        })
      }
      else {
        await updatePlatformNotification(currentNotificationId.value, {
          title: form.title,
          content: form.content,
          status,
        })
      }

      ElMessage.success(status === PLATFORM_NOTIFICATION_STATUS.PUBLISHED ? t('admin.notifications.publishedSuccess') : t('admin.notifications.draftSaved'))
      drawerVisible.value = false
      await loadNotifications()
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('admin.notifications.saveFailed')))
    }
    finally {
      isSaving.value = false
    }
  }

  async function deleteNotification(notification: PlatformNotification) {
    try {
      await ElMessageBox.confirm(
        t('admin.notifications.deleteConfirm'),
        t('admin.notifications.deleteTitle', { title: notification.title }),
        {
          type: 'warning',
          confirmButtonText: t('admin.common.delete'),
          cancelButtonText: t('admin.common.cancel'),
          confirmButtonClass: 'el-button--danger',
        },
      )
    }
    catch {
      return
    }

    deletingNotificationId.value = notification.id

    try {
      await deletePlatformNotification(notification.id)
      ElMessage.success(t('admin.notifications.deleteSuccess'))

      if (currentNotificationId.value === notification.id) {
        drawerVisible.value = false
      }

      await loadNotifications()
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('admin.notifications.deleteFailed')))
    }
    finally {
      deletingNotificationId.value = ''
    }
  }

  async function uploadNotificationImage(file: File): Promise<TiptapEditorUploadedImage> {
    if (file.size > PLATFORM_NOTIFICATION_IMAGE_MAX_BYTES) {
      throw new Error(t('admin.notifications.imageSizeLimit', { size: PLATFORM_NOTIFICATION_IMAGE_SIZE_LIMIT_LABEL }))
    }

    const asset = await uploadPlatformNotificationImage(file)

    if (asset.contentUrl) {
      imageSrcCache.set(asset.id, Promise.resolve(asset.contentUrl))
    }

    return asset
  }

  const resolveNotificationImageSrc: TiptapEditorResolveImageSrc = async (assetId) => {
    const cachedSrc = imageSrcCache.get(assetId)

    if (cachedSrc) {
      return cachedSrc
    }

    const pendingSrc = resolvePlatformNotificationAssets({
      assetIds: [assetId],
    }).then((response) => {
      const asset = response.assets.find(item => item.id === assetId)
      return asset?.contentUrl ?? null
    }).catch((error) => {
      imageSrcCache.delete(assetId)
      throw error
    })

    imageSrcCache.set(assetId, pendingSrc)
    return pendingSrc
  }

  async function handleStatusFilterChange(value: string | number | boolean | undefined) {
    if (value !== '' && !PLATFORM_NOTIFICATION_STATUS_VALUES.includes(value as PlatformNotificationStatus)) {
      return
    }

    query.status = value as NotificationStatusFilter
    query.pageNo = 1
    await loadNotifications()
  }

  async function handlePageChange(pageNo: number) {
    query.pageNo = pageNo
    await loadNotifications()
  }

  async function handlePageSizeChange(pageSize: number) {
    query.pageSize = pageSize
    query.pageNo = 1
    await loadNotifications()
  }

  onMounted(loadNotifications)

  return {
    closeDrawer,
    deletingNotificationId,
    drawerTitle,
    drawerVisible,
    errorMessage,
    form,
    formRules,
    getStatusLabel,
    handlePageChange,
    handlePageSizeChange,
    handleStatusFilterChange,
    isEditing,
    isLoading,
    isSaving,
    isViewing,
    loadNotifications,
    notifications,
    openCreateDrawer,
    openEditDrawer,
    openViewDrawer,
    publishNotification,
    query,
    saveDraft,
    setFormRef,
    statusOptions,
    titleMaxLength: PLATFORM_NOTIFICATION_TITLE_MAX_LENGTH,
    total,
    deleteNotification,
    updateContent,
    updateTitle,
    uploadNotificationImage,
    resolveNotificationImageSrc,
  }

  function resetForm() {
    form.title = ''
    form.content = createEmptyTiptapContent()
    formRef.value?.clearValidate()
  }

  function syncForm(notification: PlatformNotification) {
    form.title = notification.title
    form.content = cloneContent(notification.content)
  }
}

function cloneContent(content: TiptapJsonContent): TiptapJsonContent {
  return JSON.parse(JSON.stringify(content)) as TiptapJsonContent
}
