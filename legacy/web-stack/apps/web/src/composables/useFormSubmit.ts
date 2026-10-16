import type { FormInstance } from 'element-plus'
import { shallowRef } from 'vue'
import { translate } from '@/i18n'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

export function useFormSubmit<T = void>(options: {
  action: () => Promise<T>
  validate?: () => boolean
  fallbackError?: string | (() => string)
  onSuccess?: (result: T) => void | Promise<void>
}) {
  const isSubmitting = shallowRef(false)

  async function submit(formRef: FormInstance | null | undefined) {
    if (formRef) {
      const valid = await formRef.validate().catch(() => false)
      if (valid === false)
        return
    }
    if (options.validate && !options.validate())
      return

    isSubmitting.value = true
    try {
      const result = await options.action()
      await options.onSuccess?.(result)
    }
    catch (error) {
      const fallbackError = typeof options.fallbackError === 'function'
        ? options.fallbackError()
        : options.fallbackError

      ElMessage.error(getRequestErrorDisplayMessage(error, fallbackError ?? translate('common.requestFailed')))
    }
    finally {
      isSubmitting.value = false
    }
  }

  return { isSubmitting, submit }
}
