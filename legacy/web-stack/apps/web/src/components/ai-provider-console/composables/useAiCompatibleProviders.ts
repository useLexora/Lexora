import type { MaybeRefOrGetter, Ref, ShallowRef } from 'vue'
import type { AiProviderConsoleMode, AiProviderFormController, AiProviderRow, CompatibleProviderKey } from '../typing'
import type { AiProvider, AiProviderPreset } from '@/apis/ai'
import { reactive, shallowRef, toValue } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  createPlatformAiProvider,
  createUserAiProvider,
  deletePlatformAiProvider,
  deleteUserAiProvider,
  updatePlatformAiProvider,
  updateUserAiProvider,
} from '@/apis/ai'
import { ElMessage, ElMessageBox } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import { isCompatibleProviderKey } from '../utils/providerDisplay'

/**
 * 兼容服务商参数。
 */
export interface UseAiCompatibleProvidersOptions {
  /** 控制台模式 */
  mode: MaybeRefOrGetter<AiProviderConsoleMode>
  /** 确保兼容服务商预设已加载 */
  ensureCompatiblePresets: () => Promise<AiProviderPreset[]>
  /** 已保存服务商 */
  providers: ShallowRef<AiProvider[]>
  /** 当前行标识 */
  selectedRowKey: Readonly<ShallowRef<string | null>>
  /** 设置当前行标识 */
  selectCatalogRow: (rowKey: string | null) => void
  /** 创建表单实例 */
  createCompatibleProviderFormRef: Readonly<Ref<AiProviderFormController | null>>
  /** 编辑表单实例 */
  editCompatibleProviderFormRef: Readonly<Ref<AiProviderFormController | null>>
  /** 选择服务商行 */
  selectRow: (rowKey: string) => Promise<void>
  /** 更新服务商缓存 */
  patchProvider: (provider: AiProvider) => void
  /** 移除服务商缓存 */
  removeProvider: (providerId: string) => void
  /** 归一化选中行 */
  normalizeSelectedRow: () => void
  /** 同步凭证表单 */
  syncCredentialForms: () => void
  /** 加载当前服务商 API Key */
  loadApiKeyForSelectedProvider: () => Promise<void>
  /** 加载当前服务商模型 */
  loadModelsForSelectedProvider: () => Promise<void>
  /** 清空模型 */
  clearModels: () => void
}

export function useAiCompatibleProviders(options: UseAiCompatibleProvidersOptions) {
  const { t } = useI18n({ useScope: 'global' })
  const isCreatingCompatibleProvider = shallowRef(false)
  const isUpdatingCompatibleProvider = shallowRef(false)
  const createCompatibleProviderDialogVisible = shallowRef(false)
  const editCompatibleProviderDialogVisible = shallowRef(false)

  const compatibleProviderCreateForm = reactive({
    providerKey: 'openai-compatible' as CompatibleProviderKey,
    providerName: '',
  })

  const compatibleProviderEditForm = reactive({
    providerId: '',
    providerKey: 'openai-compatible' as CompatibleProviderKey,
    providerName: '',
  })

  const compatibleProviderCreateRules = {
    providerKey: [{ required: true, message: t('aiProvider.validation.providerTypeRequired'), trigger: 'change' }],
    providerName: [{ required: true, message: t('aiProvider.validation.providerNameRequired'), trigger: 'blur' }],
  }

  const compatibleProviderEditRules = {
    providerKey: [{ required: true, message: t('aiProvider.validation.providerTypeRequired'), trigger: 'change' }],
    providerName: [{ required: true, message: t('aiProvider.validation.providerNameRequired'), trigger: 'blur' }],
  }

  async function openCreateCompatibleProviderDialog() {
    const presets = await loadCompatibleProviderPresets()
    if (!presets) {
      return
    }

    const providerKey = presets[0]?.providerKey
    compatibleProviderCreateForm.providerKey = (providerKey as CompatibleProviderKey | undefined) ?? 'openai-compatible'
    compatibleProviderCreateForm.providerName = ''
    createCompatibleProviderDialogVisible.value = true
  }

  async function createCompatibleProvider() {
    const isValid = await options.createCompatibleProviderFormRef.value?.validate().catch(() => false)
    if (!isValid) {
      return
    }

    isCreatingCompatibleProvider.value = true

    try {
      const provider = currentMode() === 'platform'
        ? await createPlatformAiProvider({
            providerKey: compatibleProviderCreateForm.providerKey,
            providerName: compatibleProviderCreateForm.providerName.trim(),
          })
        : await createUserAiProvider({
            providerKey: compatibleProviderCreateForm.providerKey,
            providerName: compatibleProviderCreateForm.providerName.trim(),
          })

      createCompatibleProviderDialogVisible.value = false
      options.patchProvider(provider)
      await options.selectRow(`provider:${provider.providerId}`)
      ElMessage.success(t('aiProvider.messages.providerAdded'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('aiProvider.errors.addProvider')))
    }
    finally {
      isCreatingCompatibleProvider.value = false
    }
  }

  async function openEditCompatibleProviderDialog(row: AiProviderRow) {
    if (row.kind !== 'compatible' || !isCompatibleProviderKey(row.providerKey)) {
      return
    }

    const presets = await loadCompatibleProviderPresets()
    if (!presets) {
      return
    }

    compatibleProviderEditForm.providerId = row.provider.providerId
    compatibleProviderEditForm.providerKey = row.providerKey
    compatibleProviderEditForm.providerName = row.title
    editCompatibleProviderDialogVisible.value = true
  }

  async function updateCompatibleProvider() {
    const isValid = await options.editCompatibleProviderFormRef.value?.validate().catch(() => false)
    if (!isValid) {
      return
    }

    const current = options.providers.value.find(provider => provider.providerId === compatibleProviderEditForm.providerId)
    if (!current) {
      editCompatibleProviderDialogVisible.value = false
      return
    }

    if (current.providerKey !== compatibleProviderEditForm.providerKey) {
      await ElMessageBox.confirm(
        t('aiProvider.compatibleProvider.switchTypeConfirm'),
        t('aiProvider.compatibleProvider.switchTypeTitle'),
        {
          type: 'warning',
          confirmButtonText: t('aiProvider.common.continue'),
          cancelButtonText: t('aiProvider.common.cancel'),
        },
      )
    }

    isUpdatingCompatibleProvider.value = true

    try {
      const provider = currentMode() === 'platform'
        ? await updatePlatformAiProvider(compatibleProviderEditForm.providerId, {
            providerKey: compatibleProviderEditForm.providerKey,
            providerName: compatibleProviderEditForm.providerName.trim(),
          })
        : await updateUserAiProvider(compatibleProviderEditForm.providerId, {
            providerKey: compatibleProviderEditForm.providerKey,
            providerName: compatibleProviderEditForm.providerName.trim(),
          })

      options.patchProvider(provider)
      editCompatibleProviderDialogVisible.value = false
      options.selectCatalogRow(`provider:${provider.providerId}`)
      if (current.providerKey !== provider.providerKey) {
        options.clearModels()
      }
      options.syncCredentialForms()
      await options.loadApiKeyForSelectedProvider()
      ElMessage.success(t('aiProvider.messages.providerUpdated'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('aiProvider.errors.updateProvider')))
    }
    finally {
      isUpdatingCompatibleProvider.value = false
    }
  }

  async function deleteCompatibleProvider(row: AiProviderRow) {
    if (row.kind !== 'compatible') {
      return
    }

    await ElMessageBox.confirm(
      t('aiProvider.compatibleProvider.deleteConfirm', { title: row.title }),
      t('aiProvider.compatibleProvider.deleteTitle'),
      {
        type: 'warning',
        confirmButtonText: t('aiProvider.common.delete'),
        cancelButtonText: t('aiProvider.common.cancel'),
      },
    )

    try {
      if (currentMode() === 'platform') {
        await deletePlatformAiProvider(row.provider.providerId)
      }
      else {
        await deleteUserAiProvider(row.provider.providerId)
      }

      options.removeProvider(row.provider.providerId)
      if (options.selectedRowKey.value === row.rowKey) {
        options.selectCatalogRow(null)
        options.clearModels()
      }
      options.normalizeSelectedRow()
      options.syncCredentialForms()
      await Promise.all([
        options.loadApiKeyForSelectedProvider(),
        options.loadModelsForSelectedProvider(),
      ])
      ElMessage.success(t('aiProvider.messages.providerDeleted'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('aiProvider.errors.deleteProvider')))
    }
  }

  async function handleCompatibleProviderCommand(command: string, row: AiProviderRow) {
    if (command === 'edit') {
      await openEditCompatibleProviderDialog(row)
      return
    }

    if (command === 'delete') {
      await deleteCompatibleProvider(row)
    }
  }

  function currentMode() {
    return toValue(options.mode)
  }

  async function loadCompatibleProviderPresets() {
    try {
      const presets = await options.ensureCompatiblePresets()
      if (presets.length === 0) {
        ElMessage.warning(t('aiProvider.messages.noCompatibleProviderTypes'))
        return null
      }

      return presets
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('aiProvider.errors.loadProviderTypes')))
      return null
    }
  }

  return {
    isCreatingCompatibleProvider,
    isUpdatingCompatibleProvider,
    createCompatibleProviderDialogVisible,
    editCompatibleProviderDialogVisible,
    compatibleProviderCreateForm,
    compatibleProviderEditForm,
    compatibleProviderCreateRules,
    compatibleProviderEditRules,
    openCreateCompatibleProviderDialog,
    createCompatibleProvider,
    updateCompatibleProvider,
    handleCompatibleProviderCommand,
  }
}
