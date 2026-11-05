import type { BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { ModelCapabilityOverrides } from '@buddy-shared/providers/providerCapabilities'
import { BUDDY_THINKING_LEVELS } from '@buddy-shared/conversation/modelSelection'
import { supportsAudioInputApi, supportsVideoInputApi } from '@buddy-shared/providers/mediaInput'
import { supportsPdfInputApi } from '@buddy-shared/providers/pdfInput'
import { computed, onScopeDispose, reactive, shallowRef, watch } from 'vue'

const inputFields = ['image', 'pdf', 'audio', 'video', 'toolCall'] as const

interface ModelCapabilitiesFormOptions {
  section: 'input' | 'thinking'
  model: () => LocalRuntimeModelOption
  show: () => boolean
  disabled: () => boolean
  save: (capabilities: ModelCapabilityOverrides | null) => Promise<boolean>
}

export function useModelCapabilitiesForm(options: ModelCapabilitiesFormOptions) {
  const editing = shallowRef(false)
  const submitting = shallowRef(false)
  const form = reactive({ image: false, pdf: false, audio: false, video: false, toolCall: false, levels: [] as BuddyThinkingLevel[] })
  const editableInputs = computed(() => ({
    image: true,
    toolCall: true,
    pdf: supportsPdfInputApi(options.model().api),
    audio: supportsAudioInputApi(options.model().api),
    video: supportsVideoInputApi(options.model().api),
  }))
  let initial = { ...form }
  const valid = computed(() => options.section === 'input' || form.levels.length > 0)
  const hasOverride = computed(() => {
    const model = options.model()
    const overrides = model.capabilityOverrides
    if (!overrides)
      return false
    return options.section === 'thinking'
      ? overrides.reasoningOptions !== undefined
      : inputFields.some(key => overrides[key] !== undefined)
  })
  let generation = 0

  watch([options.show, () => options.model().providerId, () => options.model().modelId], () => {
    generation += 1
    editing.value = false
    submitting.value = false
  }, { immediate: true, flush: 'sync' })
  onScopeDispose(() => {
    generation += 1
  })

  function startEditing() {
    const model = options.model()
    for (const key of inputFields)
      form[key] = editableInputs.value[key] && (key === 'toolCall' ? model.toolCalling !== false : model.capabilities.includes(key))
    const levels = model.capabilityOverrides?.reasoningOptions ?? model.reasoningOptions
    form.levels = levels.length ? [...levels] : ['off']
    initial = { ...form, levels: [...form.levels] }
    editing.value = true
  }

  async function persist(capabilities: ModelCapabilityOverrides) {
    if (submitting.value || options.disabled())
      return
    const requestGeneration = generation
    submitting.value = true
    try {
      const saved = await options.save(Object.keys(capabilities).length ? capabilities : null)
      if (saved && requestGeneration === generation)
        editing.value = false
    }
    finally {
      if (requestGeneration === generation)
        submitting.value = false
    }
  }

  function save() {
    if (!valid.value)
      return
    const overrides = readOverrides()
    if (options.section === 'input') {
      for (const key of inputFields) {
        if (editableInputs.value[key] && form[key] !== initial[key])
          overrides[key] = form[key]
      }
    }
    else if (!sameLevels(form.levels, initial.levels)) {
      overrides.reasoningOptions = BUDDY_THINKING_LEVELS.filter(level => form.levels.includes(level))
    }
    return persist(overrides)
  }

  function restore() {
    const overrides = readOverrides()
    if (options.section === 'thinking')
      delete overrides.reasoningOptions
    else
      inputFields.forEach(key => delete overrides[key])
    return persist(overrides)
  }

  function readOverrides(): ModelCapabilityOverrides {
    const { reasoningOptions, ...input } = options.model().capabilityOverrides ?? {}
    return reasoningOptions ? { ...input, reasoningOptions: [...reasoningOptions] } : input
  }

  function updateLevels(values: Array<string | number>) {
    form.levels = BUDDY_THINKING_LEVELS.filter(level => values.includes(level))
  }

  return { editing, form, editableInputs, valid, hasOverride, submitting, startEditing, updateLevels, save, restore }
}

function sameLevels(left: readonly BuddyThinkingLevel[], right: readonly BuddyThinkingLevel[]) {
  return left.length === right.length && left.every(level => right.includes(level))
}
