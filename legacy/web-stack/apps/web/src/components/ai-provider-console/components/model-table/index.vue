<script setup lang="ts">
import type { AiProviderModelTableEmits, AiProviderModelTableProps } from './typing'
import type {
  AiModelCapability,
  AiModelModality,
  AiModelType,
} from '@/apis/ai'
import {
  AI_MODEL_CAPABILITY,
  AI_MODEL_MODALITY,
  AI_MODEL_TYPE,
} from '@haohaoxue/lexora-contracts/ai/constants'
import { useI18n } from 'vue-i18n'
import {
  formatModelLimit,
} from '../../utils/modelDisplay'

defineProps<AiProviderModelTableProps>()

const emit = defineEmits<AiProviderModelTableEmits>()
const { t } = useI18n({ useScope: 'global' })

const MODEL_NAME_COLUMN_WIDTH = 188
const MODEL_USAGE_COLUMN_WIDTH = 84
const MODEL_MODALITY_COLUMN_MIN_WIDTH = 76
const MODEL_CAPABILITY_COLUMN_MIN_WIDTH = 150
const MODEL_LIMIT_COLUMN_MIN_WIDTH = 104
const MODEL_ACTION_COLUMN_WIDTH = 48
const MODEL_STATUS_COLUMN_WIDTH = 56

function getModalityLabel(modality: AiModelModality) {
  const keyMap = {
    [AI_MODEL_MODALITY.TEXT]: 'aiProvider.modality.text',
    [AI_MODEL_MODALITY.IMAGE]: 'aiProvider.modality.image',
    [AI_MODEL_MODALITY.AUDIO]: 'aiProvider.modality.audio',
    [AI_MODEL_MODALITY.VIDEO]: 'aiProvider.modality.video',
    [AI_MODEL_MODALITY.FILE]: 'aiProvider.modality.file',
    [AI_MODEL_MODALITY.EMBEDDING]: 'aiProvider.modality.embedding',
  } as const

  return t(keyMap[modality])
}

function getCapabilityLabel(capability: AiModelCapability) {
  const keyMap = {
    [AI_MODEL_CAPABILITY.STREAMING]: 'aiProvider.capability.streaming',
    [AI_MODEL_CAPABILITY.TOOL_CALL]: 'aiProvider.capability.toolCall',
    [AI_MODEL_CAPABILITY.REASONING]: 'aiProvider.capability.reasoning',
    [AI_MODEL_CAPABILITY.JSON_MODE]: 'aiProvider.capability.jsonMode',
    [AI_MODEL_CAPABILITY.STRUCTURED_OUTPUT]: 'aiProvider.capability.structuredOutput',
  } as const

  return t(keyMap[capability])
}

function getModelTypeLabel(modelType: AiModelType) {
  const keyMap = {
    [AI_MODEL_TYPE.CHAT]: 'aiProvider.modelType.chat',
    [AI_MODEL_TYPE.EMBEDDING]: 'aiProvider.modelType.embedding',
    [AI_MODEL_TYPE.RERANK]: 'aiProvider.modelType.rerank',
    [AI_MODEL_TYPE.IMAGE]: 'aiProvider.modelType.image',
    [AI_MODEL_TYPE.AUDIO]: 'aiProvider.modelType.audio',
  } as const

  return t(keyMap[modelType])
}
</script>

<template>
  <ElTable
    :data="models"
    row-key="modelId"
    height="100%"
    class="ai-provider-console__model-table"
  >
    <ElTableColumn
      :label="t('aiProvider.model.model')"
      prop="modelName"
      :width="MODEL_NAME_COLUMN_WIDTH"
      fixed
      show-overflow-tooltip
    >
      <template #default="{ row }">
        <div class="ai-provider-console__table-model-cell">
          <span class="ai-provider-console__table-model-name">
            {{ row.modelName }}
          </span>
          <span class="ai-provider-console__table-model-id">
            {{ row.modelId }}
          </span>
        </div>
      </template>
    </ElTableColumn>

    <ElTableColumn
      :label="t('aiProvider.model.type')"
      :width="MODEL_USAGE_COLUMN_WIDTH"
      align="center"
      class-name="ai-provider-console__table-usage-column"
    >
      <template #default="{ row }">
        <div class="ai-provider-console__table-usage-cell">
          <ElTag size="small" effect="plain">
            {{ getModelTypeLabel(row.modelType as AiModelType) }}
          </ElTag>
        </div>
      </template>
    </ElTableColumn>

    <ElTableColumn
      :label="t('aiProvider.model.input')"
      :min-width="MODEL_MODALITY_COLUMN_MIN_WIDTH"
      show-overflow-tooltip
    >
      <template #default="{ row }">
        <div class="ai-provider-console__table-tags-cell">
          <ElTag
            v-for="modality in row.inputModalities"
            :key="modality"
            size="small"
            effect="plain"
          >
            {{ getModalityLabel(modality as AiModelModality) }}
          </ElTag>
        </div>
      </template>
    </ElTableColumn>

    <ElTableColumn
      :label="t('aiProvider.model.output')"
      :min-width="MODEL_MODALITY_COLUMN_MIN_WIDTH"
      show-overflow-tooltip
    >
      <template #default="{ row }">
        <div class="ai-provider-console__table-tags-cell">
          <ElTag
            v-for="modality in row.outputModalities"
            :key="modality"
            size="small"
            effect="plain"
          >
            {{ getModalityLabel(modality as AiModelModality) }}
          </ElTag>
        </div>
      </template>
    </ElTableColumn>

    <ElTableColumn
      :label="t('aiProvider.model.capabilities')"
      :min-width="MODEL_CAPABILITY_COLUMN_MIN_WIDTH"
      show-overflow-tooltip
    >
      <template #default="{ row }">
        <div class="ai-provider-console__table-tags-cell">
          <ElTag
            v-for="capability in row.capabilities"
            :key="capability"
            size="small"
            effect="plain"
          >
            {{ getCapabilityLabel(capability as AiModelCapability) }}
          </ElTag>
          <span v-if="row.capabilities.length === 0" class="ai-provider-console__table-muted">
            -
          </span>
        </div>
      </template>
    </ElTableColumn>

    <ElTableColumn
      :label="t('aiProvider.model.contextAndOutput')"
      :min-width="MODEL_LIMIT_COLUMN_MIN_WIDTH"
      show-overflow-tooltip
    >
      <template #default="{ row }">
        <div class="ai-provider-console__table-limit-cell">
          {{ formatModelLimit(row.contextWindow) }} / {{ formatModelLimit(row.maxOutputTokens) }}
        </div>
      </template>
    </ElTableColumn>

    <ElTableColumn
      v-if="canConfigure"
      :label="t('aiProvider.model.capabilityColumn')"
      :width="MODEL_ACTION_COLUMN_WIDTH"
      align="center"
      class-name="ai-provider-console__table-action-column"
    >
      <template #default="{ row }">
        <ElTooltip :content="t('aiProvider.dialog.modelCapabilityTitle')" placement="top" effect="light">
          <ElButton
            text
            circle
            :aria-label="t('aiProvider.dialog.modelCapabilityTitle')"
            :disabled="isModelUpdating(row)"
            @click="emit('configureModel', row)"
          >
            <SvgIcon category="ui" icon="settings-gear" size="0.95rem" />
          </ElButton>
        </ElTooltip>
      </template>
    </ElTableColumn>

    <ElTableColumn
      :label="t('aiProvider.status.enabled')"
      :width="MODEL_STATUS_COLUMN_WIDTH"
      align="right"
      class-name="ai-provider-console__table-status-column"
    >
      <template #default="{ row }">
        <div class="ai-provider-console__table-switch-cell">
          <ElSwitch
            :model-value="row.enabled ?? false"
            :loading="isModelUpdating(row)"
            :disabled="isModelUpdating(row)"
            @change="value => emit('updateModelStatus', row, value)"
          />
        </div>
      </template>
    </ElTableColumn>
  </ElTable>
</template>
