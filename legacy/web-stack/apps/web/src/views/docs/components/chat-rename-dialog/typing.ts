export interface DocsChatRenameDialogProps {
  loading: boolean
  modelValue: boolean
  title: string
}

export interface DocsChatRenameDialogEmits {
  'update:modelValue': [value: boolean]
  'confirm': [title: string]
}
