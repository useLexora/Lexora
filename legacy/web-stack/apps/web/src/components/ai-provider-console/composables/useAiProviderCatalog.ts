import type { MaybeRefOrGetter } from 'vue'
import type { AiProviderConsoleMode, AiProviderRow } from '../typing'
import type { AiProvider, AiProviderPreset } from '@/apis/ai'
import { computed, shallowRef, toValue } from 'vue'
import {
  getAiCompatibleProviderPresets,
  getPlatformAiProviders,
  getUserAiProviders,
} from '@/apis/ai'

export interface UseAiProviderCatalogOptions {
  /** 控制台模式 */
  mode: MaybeRefOrGetter<AiProviderConsoleMode>
}

export function useAiProviderCatalog(options: UseAiProviderCatalogOptions) {
  const compatiblePresets = shallowRef<AiProviderPreset[]>([])
  const providers = shallowRef<AiProvider[]>([])
  const selectedRowKey = shallowRef<string | null>(null)
  const searchKeyword = shallowRef('')
  let compatiblePresetsPromise: Promise<AiProviderPreset[]> | null = null

  const allRows = computed<AiProviderRow[]>(() => providers.value.map(provider => ({
    rowKey: `provider:${provider.providerId}`,
    kind: provider.source === 'compatible' ? 'compatible' : 'preset',
    providerKey: provider.providerKey,
    title: provider.providerName,
    provider,
  })))

  const filteredRows = computed(() => {
    const keyword = searchKeyword.value.trim().toLowerCase()
    if (!keyword) {
      return allRows.value
    }

    return allRows.value.filter(row =>
      row.title.toLowerCase().includes(keyword)
      || row.providerKey.toLowerCase().includes(keyword),
    )
  })

  const selectedRow = computed(() => allRows.value.find(row => row.rowKey === selectedRowKey.value) ?? null)
  const selectedProvider = computed(() => selectedRow.value?.provider ?? null)
  const selectedTitle = computed(() => selectedRow.value?.title ?? '')

  async function loadCatalog() {
    const nextProviders = await loadProviders()

    providers.value = nextProviders
    normalizeSelectedRow()
  }

  async function ensureCompatiblePresets() {
    if (compatiblePresets.value.length > 0) {
      return compatiblePresets.value
    }

    compatiblePresetsPromise ??= getAiCompatibleProviderPresets()
      .then((nextCompatiblePresets) => {
        compatiblePresets.value = nextCompatiblePresets
        return nextCompatiblePresets
      })
      .finally(() => {
        compatiblePresetsPromise = null
      })

    return compatiblePresetsPromise
  }

  function loadProviders() {
    return currentMode() === 'platform'
      ? getPlatformAiProviders()
      : getUserAiProviders()
  }

  function selectRow(rowKey: string | null) {
    selectedRowKey.value = rowKey
  }

  function patchProvider(provider: AiProvider) {
    if (providers.value.some(item => item.providerId === provider.providerId)) {
      providers.value = providers.value.map(item => item.providerId === provider.providerId ? provider : item)
      return
    }

    providers.value = [provider, ...providers.value]
  }

  function patchProviderModelCount(providerId: string, modelCount: number) {
    providers.value = providers.value.map(item => item.providerId === providerId
      ? { ...item, modelCount }
      : item)
  }

  function removeProvider(providerId: string) {
    providers.value = providers.value.filter(provider => provider.providerId !== providerId)
  }

  function normalizeSelectedRow() {
    if (selectedRowKey.value && allRows.value.some(row => row.rowKey === selectedRowKey.value)) {
      return
    }

    selectedRowKey.value = allRows.value[0]?.rowKey ?? null
  }

  function currentMode() {
    return toValue(options.mode)
  }

  return {
    compatiblePresets,
    providers,
    selectedRowKey,
    searchKeyword,
    filteredRows,
    selectedRow,
    selectedProvider,
    selectedTitle,
    loadCatalog,
    ensureCompatiblePresets,
    selectRow,
    patchProvider,
    patchProviderModelCount,
    removeProvider,
    normalizeSelectedRow,
  }
}
