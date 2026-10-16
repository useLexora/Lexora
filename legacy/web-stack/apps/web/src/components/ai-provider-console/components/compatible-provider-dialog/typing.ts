import type {
  AiCompatibleProviderEditForm,
  AiCompatibleProviderForm,
  AiProviderFormRules,
  AiProviderPreset,
} from '../../typing'

export type AiCompatibleProviderDialogMode = 'create' | 'edit'

export interface AiCompatibleProviderDialogProps {
  mode: AiCompatibleProviderDialogMode
  presets: AiProviderPreset[]
  form: AiCompatibleProviderForm | AiCompatibleProviderEditForm
  rules: AiProviderFormRules
  loading: boolean
}

export interface AiCompatibleProviderDialogEmits {
  submit: []
}
