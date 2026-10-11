<script setup lang="ts">
import type { AutomationEditorEmits, AutomationEditorProps } from './typing'
import { NAlert, NButton, NForm, NFormItem, NInput, NScrollbar, NSelect, NSpin } from 'naive-ui'
import { shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopAutomationPromptComposer from './DesktopAutomationPromptComposer.vue'
import DesktopAutomationScheduleEditor from './DesktopAutomationScheduleEditor.vue'
import DesktopAutomationSchedulePreview from './DesktopAutomationSchedulePreview.vue'
import { useAutomationEditor } from './useAutomationEditor'

const props = defineProps<AutomationEditorProps>()
const emit = defineEmits<AutomationEditorEmits>()
const { t } = useBuddyI18n(() => props.language)
const runtimeNoticeVisible = shallowRef(true)
const { canSave, draftForSave, form, modelIssue, pageTitle, previewState, spaceOptions, updatePinnedModel } = useAutomationEditor(props)

function submit(): void {
  const draft = draftForSave()
  if (draft)
    emit('save', draft)
}

function close(): void {
  emit('cancel')
}
</script>

<template>
  <section class="desktop-automation-editor flex w-full h-full min-w-0 min-h-0 flex-col bg-surface">
    <header class="desktop-automation-editor__header flex-none justify-between gap-[16px] border-b-1 border-b-solid border-b-border py-0 px-[18px] h-region-header">
      <div class="desktop-automation-editor__breadcrumb min-w-0 gap-[7px] text-muted text-[13px]">
        <DesktopIcon name="navigationAutomation" />
        <button type="button" @click="close">
          {{ t('desktop.automations.title') }}
        </button>
        <span>/</span>
        <strong>{{ pageTitle }}</strong>
      </div>
      <div class="desktop-automation-editor__header-actions flex-none gap-[8px]">
        <NButton :disabled="busy" @click="close">
          {{ t('desktop.automations.editor.cancel') }}
        </NButton>
        <NButton
          type="primary"
          :disabled="!canSave"
          :loading="busy"
          @click="submit"
        >
          {{ t('desktop.automations.editor.save') }}
        </NButton>
      </div>
    </header>

    <NScrollbar class="desktop-automation-editor__scroll">
      <div class="desktop-automation-editor__content grid w-[min(100%,_1120px)] gap-[16px] my-0 mx-auto pt-[clamp(18px,_3vw,_34px)] pr-[clamp(18px,_3vw,_34px)] pb-[48px] pl-[clamp(18px,_3vw,_34px)]">
        <NAlert
          v-if="mode === 'create' && runtimeNoticeVisible"
          class="desktop-automation-editor__runtime-alert"
          type="info"
          :bordered="false"
          closable
          @close="runtimeNoticeVisible = false"
        >
          {{ t('desktop.automations.editor.runtimeTip') }}
        </NAlert>
        <NAlert v-if="error" type="error" :bordered="false">
          {{ error }}
        </NAlert>

        <NSpin class="desktop-automation-editor__body" :show="loading">
          <NForm
            v-if="mode === 'create' || automation"
            class="desktop-automation-editor__form"
            label-placement="top"
            @submit.prevent="submit"
          >
            <NFormItem :label="t('desktop.automations.editor.name')" required>
              <NInput
                v-model:value="form.name"
                :maxlength="80"
                placeholder=""
              />
            </NFormItem>

            <div class="desktop-automation-editor__space-field grid gap-[4px]">
              <NFormItem :label="t('desktop.automations.editor.space')">
                <NSelect
                  v-model:value="form.spaceId"
                  clearable
                  filterable
                  :options="spaceOptions"
                  :placeholder="t('desktop.automations.editor.spacePlaceholder')"
                />
              </NFormItem>
              <p>{{ t('desktop.automations.editor.spaceHint') }}</p>
            </div>

            <NFormItem :label="t('desktop.automations.editor.prompt')" required>
              <DesktopAutomationPromptComposer
                :execution-profile="form.executionProfile"
                :language="language"
                :models="models"
                :prompt="form.prompt"
                :providers="providers"
                :selected-effort="form.reasoning"
                :selected-model-id="form.modelMode === 'pinned' ? form.pinnedModelKey : null"
                @update-effort="form.reasoning = $event"
                @update-execution-profile="form.executionProfile = $event"
                @update-model="updatePinnedModel"
                @update-prompt="form.prompt = $event"
              />
            </NFormItem>

            <NAlert v-if="modelIssue" type="warning" :bordered="false">
              {{ t(`desktop.automations.editor.${modelIssue}`) }}
            </NAlert>

            <DesktopAutomationScheduleEditor
              :language="language"
              :value="form"
              @update="Object.assign(form, $event)"
            />

            <DesktopAutomationSchedulePreview
              :language="language"
              :state="previewState"
              :timezone="form.timezone"
            />
          </NForm>

          <div v-else-if="!loading" class="desktop-automation-editor__unavailable grid min-h-[260px] gap-[12px] text-muted text-center">
            <p>{{ t('desktop.automations.editor.loadUnavailable') }}</p>
            <NButton @click="close">
              {{ t('desktop.automations.editor.cancel') }}
            </NButton>
          </div>
        </NSpin>
      </div>
    </NScrollbar>
  </section>
</template>

<style scoped lang="scss">
.desktop-automation-editor__header,
.desktop-automation-editor__breadcrumb,
.desktop-automation-editor__header-actions {
  display: flex;
  align-items: center;
}

.desktop-automation-editor__breadcrumb {
  > .n-icon,
  > .desktop-icon {
    flex: none;
    color: var(--buddy-text-primary);
    font-size: 18px;
  }

  button:not(.n-button) {
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 0;
  }

  button:not(.n-button):hover {
    color: var(--buddy-accent-text);
  }

  button:not(.n-button):focus-visible {
    border-radius: 4px;
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: 2px;
  }

  strong {
    overflow: hidden;
    color: var(--buddy-text-strong);
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.desktop-automation-editor__scroll {
  min-height: 0;
  flex: 1;
}

.desktop-automation-editor__body {
  min-height: 280px;

  :deep(.n-spin-container),
  :deep(.n-spin-content) {
    min-height: 280px;
  }
}

.desktop-automation-editor__form {
  display: grid;
}

.desktop-automation-editor__space-field {
  p {
    margin: -10px 0 8px;
    color: var(--buddy-text-muted);
    font-size: 11px;
    line-height: 1.5;
  }
}

.desktop-automation-editor__form {
  gap: 10px;
}

.desktop-automation-editor__unavailable {
  place-content: center;
  justify-items: center;

  p {
    margin: 0;
  }
}

@media (max-width: 760px) {
  .desktop-automation-editor__header {
    padding: 0 12px;
  }

  .desktop-automation-editor__content {
    padding: 16px 16px 48px;
  }
}
</style>
