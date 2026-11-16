import type { LocalCustomProvider, LocalProvider } from '@buddy-shared/providers/providerApi'
import type { ProviderRequestHeader } from '@buddy-shared/providers/providerHeaders'
import type { Ref } from 'vue'
import type { ProviderConnectionActions } from './typing'
import { customProviderSchema } from '@buddy-shared/providers/providerApi'
import { providerRequestHeadersSchema } from '@buddy-shared/providers/providerHeaders'
import { providerDisplayNameSchema, supportsUnauthenticatedProviderApi } from '@buddy-shared/providers/providerInput'
import { computed, reactive, shallowRef, watch } from 'vue'

interface ProviderConnectionInput {
  actions: ProviderConnectionActions
  provider: LocalProvider
}

export function useProviderConnectionForm(props: ProviderConnectionInput, show: Ref<boolean>) {
  const saving = shallowRef(false)
  const form = reactive({ api: '', baseUrl: '', description: '', displayName: '', requestHeaders: [] as ProviderRequestHeader[] })
  const customInput = computed<LocalCustomProvider>(() => ({
    api: form.api as LocalCustomProvider['api'],
    authentication: props.provider.authentication === 'none' && supportsUnauthenticatedProviderApi(form.api) ? 'none' : 'api_key',
    baseUrl: form.baseUrl.trim(),
    description: form.description.trim() || undefined,
    displayName: form.displayName.trim(),
    enabled: props.provider.enabled,
    id: props.provider.id,
    requestHeaders: form.requestHeaders.map(header => ({ ...header })),
  }))
  const canSave = computed(() => props.provider.custom
    ? customProviderSchema.safeParse(customInput.value).success
    : providerDisplayNameSchema.safeParse(form.displayName).success && providerRequestHeadersSchema.safeParse(form.requestHeaders).success)

  watch([show, () => props.provider], ([visible, provider]) => {
    if (!visible) {
      props.actions.clearError()
      return
    }
    props.actions.clearError()
    form.api = provider.api ?? 'openai-responses'
    form.baseUrl = provider.baseUrl ?? ''
    form.description = provider.description ?? ''
    form.displayName = provider.displayName
    form.requestHeaders = (provider.requestHeaders ?? []).map(header => ({ ...header }))
  }, { immediate: true })

  function close() {
    props.actions.clearError()
    show.value = false
  }

  async function save() {
    if (saving.value || !canSave.value)
      return
    saving.value = true
    try {
      const succeeded = props.provider.custom
        ? await props.actions.save(customInput.value)
        : await props.actions.rename(props.provider.id, form.displayName.trim(), form.requestHeaders.map(header => ({ ...header })))
      if (succeeded)
        close()
    }
    finally {
      saving.value = false
    }
  }

  return { saving, form, canSave, close, save }
}
