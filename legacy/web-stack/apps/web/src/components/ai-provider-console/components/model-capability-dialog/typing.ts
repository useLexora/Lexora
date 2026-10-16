import type {
  AiProviderFormRules,
  AiProviderModelCapabilityForm,
} from '../../typing'

export interface AiProviderModelCapabilityDialogProps {
  form: AiProviderModelCapabilityForm
  rules: AiProviderFormRules
  loading: boolean
}

export interface AiProviderModelCapabilityDialogEmits {
  submit: []
}
