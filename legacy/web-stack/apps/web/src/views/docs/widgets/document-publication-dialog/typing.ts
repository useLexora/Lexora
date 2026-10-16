export interface DocumentPublicationDialogProps {
  modelValue: boolean
  documentId?: string | null
}

export interface DocumentPublicationDialogEmits {
  'update:modelValue': [visible: boolean]
}
