<script setup lang="ts">
import { buddySettingsSchema } from '@buddy-shared/buddies/buddySettings'
import { NAlert, NButton, NModal, NScrollbar, NSkeleton, NSwitch, NTooltip, useMessage } from 'naive-ui'
import { computed, onScopeDispose, shallowRef } from 'vue'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useBuddiesContext } from '../buddiesContext'
import { buddyLabels } from '../buddyLabels'
import { useBuddyActions } from '../state/useBuddyActions'
import { useBuddyProfile } from '../state/useBuddyProfile'
import { useBuddySettings } from '../state/useBuddySettings'
import BuddyProfileCard from './BuddyProfileCard.vue'
import BuddyProfileDialog from './BuddyProfileDialog.vue'
import BuddySettingsEditor from './BuddySettingsEditor.vue'

const props = defineProps<{ buddyId: string }>()
const { api, ready } = useBuddiesContext()
const { language } = useDesktopUi()
const labels = computed(() => buddyLabels(language.value))
const { buddy, failed, refresh } = useBuddyProfile(api, props.buddyId, ready)
const { busy, error, isDefault, isBuiltin, confirmation, setDefault, setEnabled, request, confirm } = useBuddyActions(buddy)
const editing = shallowRef(false)
const message = useMessage()
let disposed = false
onScopeDispose(() => disposed = true)
const { settings, busy: saving, error: settingsError, changed, save, reset } = useBuddySettings(buddy)
const valid = computed(() => buddySettingsSchema.safeParse(settings.value).success)
const disabled = computed(() => !ready.value || busy.value || saving.value || !buddy.value || !!buddy.value.deletedAt)

async function saveSettings() {
  const saved = await save()
  if (disposed)
    return
  if (settingsError.value)
    message.error(settingsError.value)
  else if (saved)
    message.success(labels.value.settingsSaved)
}
async function runAction(action: () => Promise<void>, success?: string) {
  await action()
  if (disposed)
    return
  if (error.value)
    message.error(error.value)
  else if (success)
    message.success(success)
  await refresh()
}
async function profileSaved() {
  message.success(labels.value.saved)
  await refresh()
}
</script>

<template>
  <section class="desktop-buddy-profile flex w-full min-w-0 min-h-0 flex-1 flex-col bg-surface" data-testid="buddy-profile" data-theme-surface="layout">
    <header class="desktop-buddy-profile__header flex h-region-header flex-none items-center justify-between gap-2 px-[18px] border-b-1 border-b-solid border-b-border" data-theme-surface="header">
      <h1 class="m-0 min-w-0 flex-1 truncate text-[14px] font-600 text-fg">
        {{ labels.configuration }}
      </h1>

      <div v-if="buddy" class="flex shrink-0 items-center gap-3">
        <div class="flex items-center gap-2" data-testid="buddy-profile-actions">
          <NTooltip :disabled="!isDefault">
            <template #trigger>
              <span class="inline-flex">
                <NSwitch
                  :round="false"
                  :value="buddy.enabled"
                  :disabled="disabled || isDefault"
                  size="small"
                  :aria-label="labels.enabled"
                  @update:value="value => runAction(() => setEnabled(value), value ? labels.enabledSaved : labels.disabledSaved)"
                />
              </span>
            </template>
            {{ labels.defaultEnabledHint }}
          </NTooltip>
          <NTooltip v-if="!isBuiltin">
            <template #trigger>
              <span class="inline-flex">
                <NButton
                  class="buddy-icon-button buddy-profile-header__remove"
                  quaternary
                  size="small"
                  :disabled="disabled || isDefault"
                  :aria-label="labels.delete"
                  @click="request('delete')"
                >
                  <template #icon>
                    <DesktopIcon
                      name="delete"
                      :size="16"
                    />
                  </template>
                </NButton>
              </span>
            </template>
            {{ isDefault ? labels.defaultDeleteHint : labels.delete }}
          </NTooltip>
        </div>

        <span class="w-px h-[14px] bg-border" aria-hidden="true" />

        <div class="flex items-center gap-2" data-testid="buddy-settings-actions">
          <NButton v-if="changed || settingsError" size="tiny" quaternary :disabled="disabled" @click="reset()">
            {{ labels.discard }}
          </NButton>
          <NButton size="tiny" type="primary" :disabled="disabled || !changed || !valid" :loading="saving" @click="saveSettings">
            {{ labels.savePreferences }}
          </NButton>
        </div>
      </div>
    </header>
    <NScrollbar class="min-h-0 flex-1">
      <div class="desktop-buddy-profile__content box-border mx-auto w-full max-w-[1240px] px-[clamp(16px,3cqw,32px)] pt-6 pb-10">
        <NAlert v-if="failed" type="error" class="mb-6" :show-icon="false">
          {{ labels.loadFailed }}
          <NButton v-if="failed" size="small" @click="refresh">
            {{ labels.retry }}
          </NButton>
        </NAlert>
        <p v-if="!ready" role="status" class="text-muted">
          {{ labels.unavailable }}
        </p>
        <template v-if="buddy">
          <NAlert v-if="buddy.deletedAt" class="mb-6" :show-icon="false">
            {{ labels.deleted }}
          </NAlert>
          <BuddyProfileCard
            :buddy="buddy"
            :disabled="disabled"
            :is-default="isDefault"
            :is-builtin="isBuiltin"
            @edit="editing = true"
            @set-default="runAction(setDefault)"
            @reset-profile="request('resetProfile')"
          />
          <p v-if="changed && !valid" role="alert" class="my-3 text-[13px] text-danger">
            {{ labels.invalidSettings }}
          </p>
          <BuddySettingsEditor v-model:settings="settings" class="mt-5" :buddy="buddy" :disabled="disabled" />
          <BuddyProfileDialog v-model:show="editing" :buddy="buddy" @saved="profileSaved" />
        </template>
        <NSkeleton v-else-if="ready && !failed" :height="208" />
      </div>
    </NScrollbar>
    <NModal :show="!!confirmation" preset="dialog" type="warning" :title="confirmation?.action === 'delete' ? labels.deleteNamed(confirmation.buddy.name) : labels.resetTitle" :mask-closable="!busy" :close-on-esc="!busy" :closable="!busy" @update:show="!$event && !busy && (confirmation = null)">
      {{ confirmation?.action === 'delete' ? labels.deleteHint : labels.resetHint }}
      <template #action>
        <NButton :disabled="busy" @click="confirmation = null">
          {{ labels.cancel }}
        </NButton>
        <NButton :type="confirmation?.action === 'delete' ? 'error' : 'primary'" :disabled="!ready" :loading="busy" @click="runAction(confirm)">
          {{ confirmation?.action === 'delete' ? labels.delete : labels.resetProfile }}
        </NButton>
      </template>
    </NModal>
  </section>
</template>

<style scoped lang="scss">
.desktop-buddy-profile {
  container-type: inline-size;
}

.buddy-profile-header__remove:not(:disabled):hover {
  color: var(--buddy-status-danger-text);
}
</style>
