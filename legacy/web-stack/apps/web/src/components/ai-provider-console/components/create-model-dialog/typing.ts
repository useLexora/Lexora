import type {
  AiProviderCreateModelForm,
  AiProviderFormRules,
} from '../../typing'

export interface AiProviderCreateModelDialogProps {
  form: AiProviderCreateModelForm
  rules: AiProviderFormRules
  loading: boolean
}

export interface AiProviderCreateModelDialogEmits {
  modelIdInput: [value: string]
  submit: []
}
