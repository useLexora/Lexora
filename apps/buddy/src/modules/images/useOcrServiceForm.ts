import type { OcrServiceStatus } from '@buddy-shared/images/ocrService'
import { ocrServiceInputSchema } from '@buddy-shared/images/ocrService'
import { computed, onMounted, onScopeDispose, shallowRef } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'

export function useOcrServiceForm() {
  const api = requireDesktopApi().images
  const status = shallowRef<OcrServiceStatus>({ service: null, hasCredential: false })
  const interfaceType = shallowRef<'paddleocr'>('paddleocr')
  const endpoint = shallowRef('')
  const credential = shallowRef('')
  const clearCredential = shallowRef(false)
  const loading = shallowRef(true)
  const saving = shallowRef(false)
  const failed = shallowRef<'load' | 'save' | null>(null)
  let active = true
  const endpointChanged = computed(() => status.value.hasCredential && endpoint.value.trim() !== status.value.service?.endpoint)
  const needsCredential = computed(() => endpointChanged.value && !credential.value.trim() && !clearCredential.value)
  const valid = computed(() => !loading.value && failed.value !== 'load' && !needsCredential.value && ocrServiceInputSchema.safeParse({ api: interfaceType.value, endpoint: endpoint.value.trim() }).success)
  async function load() {
    loading.value = true
    failed.value = null
    try {
      const next = await api.ocrStatus()
      if (!active)
        return
      status.value = next
      interfaceType.value = next.service?.api ?? 'paddleocr'
      endpoint.value = next.service?.endpoint ?? ''
    }
    catch {
      if (active)
        failed.value = 'load'
    }
    finally {
      if (active)
        loading.value = false
    }
  }
  async function save(): Promise<boolean> {
    if (!valid.value || saving.value)
      return false
    saving.value = true
    failed.value = null
    try {
      await api.saveOcr({ service: { api: interfaceType.value, endpoint: endpoint.value.trim() }, ...(clearCredential.value ? { credential: null } : credential.value.trim() ? { credential: credential.value.trim() } : {}) })
      credential.value = ''
      return active
    }
    catch {
      if (active)
        failed.value = 'save'
      return false
    }
    finally {
      if (active)
        saving.value = false
    }
  }
  onMounted(load)
  onScopeDispose(() => {
    active = false
    credential.value = ''
  })
  return { status, interfaceType, endpoint, credential, clearCredential, loading, saving, failed, valid, needsCredential, load, save }
}
