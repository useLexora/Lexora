import type {
  AiDefaultModelPolicyItem,
  AiModelRef,
} from '@/apis/ai'

export interface PlatformModelSettingsPanelProps {
  visible: boolean
  modelPolicy: AiDefaultModelPolicyItem | null
  modelRef: AiModelRef | null
  loading: boolean
  saving: boolean
}

export interface PlatformModelSettingsPanelEmits {
  'update:visible': [value: boolean]
  'updateModel': [value: AiModelRef | null]
}
