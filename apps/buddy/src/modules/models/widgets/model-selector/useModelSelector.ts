import type { BuddyServiceTier, BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { ShallowRef } from 'vue'
import type { ReasoningSelectorOption } from './typing'
import { BUDDY_FAST_SERVICE_TIER } from '@buddy-shared/conversation/modelSelection'
import { useEventListener } from '@vueuse/core'
import { computed, shallowRef, watch } from 'vue'
import { resolveConcreteEffort } from '../../model/modelSelection'

type EffortTransitionDirection = 'decreasing' | 'increasing'

export interface ModelSelectorInput {
  clearable: boolean
  disabled: boolean
  models: ReadonlyArray<LocalRuntimeModelOption>
  selectedEffort: BuddyThinkingLevel | null
  selectedModel: LocalRuntimeModelOption | null
  selectedModelId: string | null
  selectedServiceTier: BuddyServiceTier | null
  showFastMode: boolean
}

interface ModelSelectorActions {
  clearModel: () => void
  updateEffort: (value: BuddyThinkingLevel | null) => void
  updateModel: (value: string) => void
  updateServiceTier: (value: BuddyServiceTier | null) => void
}

export function useModelSelector(props: ModelSelectorInput, root: Readonly<ShallowRef<HTMLElement | null>>, actions: ModelSelectorActions) {
  const isOpen = shallowRef(false)
  const activePanel = shallowRef<'advanced' | 'main'>('main')
  const secondaryPanel = shallowRef<'model' | 'reasoning' | null>(null)
  const previewEffort = shallowRef<BuddyThinkingLevel | null>(null)
  const isMeterDragging = shallowRef(false)
  const effortTransitionDirection = shallowRef<EffortTransitionDirection>('increasing')
  const canClearModel = computed(() => (
    props.clearable
    && props.selectedModelId !== null
    && !props.disabled
  ))
  const canOpen = computed(() => !props.disabled && props.models.length > 0)
  const reasoningLevelOptions = computed<ReadonlyArray<ReasoningSelectorOption>>(() => (
    props.selectedModel?.reasoningOptions.map(value => ({
      label: formatReasoningLabel(value),
      value,
    })) ?? []
  ))
  const isEffortUnavailable = computed(() => props.selectedEffort !== null
    && !props.selectedModel?.reasoningOptions.includes(props.selectedEffort))
  const selectedEffortValue = computed<BuddyThinkingLevel | null>(() => {
    if (!props.selectedModel)
      return null
    return props.selectedEffort ?? resolveConcreteEffort(props.selectedModel, null)
  })
  const displayedEffort = computed(() => previewEffort.value ?? selectedEffortValue.value)
  const selectedEffortLabel = computed(() => selectedEffortValue.value
    ? formatReasoningLabel(selectedEffortValue.value)
    : '')
  const displayedEffortLabel = computed(() => displayedEffort.value
    ? formatReasoningLabel(displayedEffort.value)
    : '')
  const supportsFastMode = computed(() => props.showFastMode && Boolean(
    props.selectedModel?.serviceTiers.some(option => option.id === BUDDY_FAST_SERVICE_TIER),
  ))
  const isFastMode = computed(() => supportsFastMode.value
    && props.selectedServiceTier === BUDDY_FAST_SERVICE_TIER)

  useEventListener(document, 'pointerdown', handleDocumentPointerDown)
  useEventListener(document, 'keydown', handleDocumentKeydown)
  watch(canOpen, (available) => {
    if (!available)
      close()
  })
  watch(() => props.selectedModel, (model) => {
    if (!model && isOpen.value) {
      activePanel.value = 'advanced'
      secondaryPanel.value = 'model'
    }
  })

  function toggle() {
    if (!canOpen.value)
      return
    isOpen.value = !isOpen.value
    activePanel.value = props.selectedModel ? 'main' : 'advanced'
    secondaryPanel.value = props.selectedModel ? null : 'model'
  }

  function open(panel?: 'model' | 'main') {
    if (!canOpen.value)
      return
    isOpen.value = true
    if (panel === 'model' || !props.selectedModel) {
      activePanel.value = 'advanced'
      secondaryPanel.value = 'model'
    }
    else {
      activePanel.value = 'main'
      secondaryPanel.value = null
    }
  }

  function close() {
    isOpen.value = false
    activePanel.value = 'main'
    secondaryPanel.value = null
    previewEffort.value = null
    isMeterDragging.value = false
  }

  function selectEffort(value: BuddyThinkingLevel) {
    actions.updateEffort(value)
    close()
  }

  function selectMeterEffort(value: BuddyThinkingLevel) {
    actions.updateEffort(value)
  }

  function previewMeterEffort(value: BuddyThinkingLevel | null) {
    if (value) {
      const currentIndex = reasoningLevelOptions.value.findIndex(option => option.value === displayedEffort.value)
      const nextIndex = reasoningLevelOptions.value.findIndex(option => option.value === value)
      if (currentIndex >= 0 && nextIndex >= 0 && currentIndex !== nextIndex)
        effortTransitionDirection.value = nextIndex > currentIndex ? 'increasing' : 'decreasing'
    }
    previewEffort.value = value
  }

  function updateMeterDragging(value: boolean) {
    isMeterDragging.value = value
  }

  function selectModel(modelId: string) {
    actions.updateModel(modelId)
  }

  function clearModel() {
    actions.clearModel()
    close()
  }

  function toggleFastMode() {
    actions.updateServiceTier(isFastMode.value ? null : BUDDY_FAST_SERVICE_TIER)
  }

  function openAdvancedPanel() {
    activePanel.value = 'advanced'
    secondaryPanel.value = null
    previewEffort.value = null
    isMeterDragging.value = false
  }

  function openMainPanel() {
    activePanel.value = 'main'
    secondaryPanel.value = null
    previewEffort.value = null
    isMeterDragging.value = false
  }

  function toggleSecondaryPanel(panel: 'model' | 'reasoning') {
    secondaryPanel.value = secondaryPanel.value === panel ? null : panel
  }

  function handleDocumentPointerDown(event: PointerEvent) {
    if (!isOpen.value || !(event.target instanceof Node) || root.value?.contains(event.target))
      return
    close()
  }

  function handleDocumentKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape')
      close()
  }

  function formatReasoningLabel(value: BuddyThinkingLevel): string {
    return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
  }

  return {
    isOpen,
    activePanel,
    secondaryPanel,
    isMeterDragging,
    effortTransitionDirection,
    canClearModel,
    canOpen,
    reasoningLevelOptions,
    selectedEffortValue,
    isEffortUnavailable,
    displayedEffort,
    selectedEffortLabel,
    displayedEffortLabel,
    supportsFastMode,
    isFastMode,
    close,
    open,
    toggle,
    clearModel,
    toggleFastMode,
    openAdvancedPanel,
    openMainPanel,
    toggleSecondaryPanel,
    selectModel,
    selectEffort,
    selectMeterEffort,
    previewMeterEffort,
    updateMeterDragging,
  }
}
