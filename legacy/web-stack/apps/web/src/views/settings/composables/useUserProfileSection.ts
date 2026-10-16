import type { FormInstance, FormItemRule } from 'element-plus'
import type { Ref } from 'vue'
import type { UserProfileSectionProps } from '../typing'
import { useClipboard } from '@vueuse/core'
import { computed, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from '@/utils/element-plus'

const DISPLAY_NAME_MIN_LENGTH = 2
const DISPLAY_NAME_MAX_LENGTH = 50

type RuleValidator = NonNullable<FormItemRule['validator']>

function resolveTrimmedValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

export function useUserProfileSection(options: {
  displayName: Ref<string>
  fileInputRef: Ref<HTMLInputElement | null>
  onSaveDisplayName: () => void
  onUpload: (file: File) => void
  props: UserProfileSectionProps
  profileFormRef: Ref<FormInstance | null>
}) {
  const { t } = useI18n({ useScope: 'global' })
  const displayName = computed({
    get: () => options.displayName.value,
    set: (nextDisplayName: string) => {
      options.displayName.value = nextDisplayName
    },
  })
  const form = reactive({
    displayName,
  })
  const createDisplayNameValidator = (): RuleValidator => (_rule, value, callback) => {
    const label = t('settings.user.profile.displayName')
    const normalizedValue = resolveTrimmedValue(value)

    if (!normalizedValue) {
      callback(new Error(t('settings.user.profile.displayNameRequired', { field: label })))
      return
    }

    if (normalizedValue.length < DISPLAY_NAME_MIN_LENGTH || normalizedValue.length > DISPLAY_NAME_MAX_LENGTH) {
      callback(new Error(t('settings.user.profile.displayNameLength', {
        field: label,
        min: DISPLAY_NAME_MIN_LENGTH,
        max: DISPLAY_NAME_MAX_LENGTH,
      })))
      return
    }

    callback()
  }
  const displayNameRules = computed(() => ({
    displayName: [{
      required: true,
      validator: createDisplayNameValidator(),
    }],
  }))
  const sectionDescription = computed(() =>
    options.props.canEditAvatar && options.props.canEditDisplayName
      ? t('settings.user.profile.descriptionEditable')
      : t('settings.user.profile.descriptionReadonly'),
  )
  const {
    copy: copyUserCode,
    copied: copiedUserCode,
    isSupported: isClipboardSupported,
  } = useClipboard({
    copiedDuring: 1400,
    legacy: true,
  })

  function handlePickAvatar() {
    if (!options.props.canEditAvatar) {
      return
    }

    options.fileInputRef.value?.click()
  }

  function handleFileChange(event: Event) {
    const target = event.target as HTMLInputElement
    const file = target.files?.[0]

    if (file) {
      options.onUpload(file)
    }

    target.value = ''
  }

  async function handleSaveDisplayName() {
    if (!options.props.canEditDisplayName) {
      return
    }

    const isValid = await options.profileFormRef.value?.validate().catch(() => false)

    if (!isValid) {
      return
    }

    options.onSaveDisplayName()
  }

  async function handleCopyUserCode() {
    if (!isClipboardSupported.value) {
      ElMessage.error(t('settings.user.profile.copyUnsupported'))
      return
    }

    try {
      await copyUserCode(options.props.userCode)
      ElMessage.success(t('settings.user.profile.accountCodeCopied'))
    }
    catch {
      ElMessage.error(t('settings.user.profile.copyFailed'))
    }
  }

  return {
    copiedUserCode,
    displayNameRules,
    form,
    handleCopyUserCode,
    handleFileChange,
    handlePickAvatar,
    handleSaveDisplayName,
    sectionDescription,
  }
}
