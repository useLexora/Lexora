<script setup lang="ts">
import type { BotsSectionEmits, BotsSectionProps } from './typing'
import { BOT_RUNTIME_STATE, WEIXIN_BOT_LOGIN_STATUS } from '@haohaoxue/lexora-contracts/bot'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UserSettingsSectionHeader from '../section-header'

const props = defineProps<BotsSectionProps>()
const emit = defineEmits<BotsSectionEmits>()
const loginVisible = defineModel<boolean>('loginVisible', { required: true })
const verifyCode = defineModel<string>('verifyCode', { required: true })
const { t } = useI18n({ useScope: 'global' })

const runtimeText = computed(() => {
  switch (props.status.runtimeState) {
    case BOT_RUNTIME_STATE.RUNNING:
      return t('settings.user.bot.runtime.running')
    case BOT_RUNTIME_STATE.STARTING:
      return t('settings.user.bot.runtime.starting')
    case BOT_RUNTIME_STATE.STOPPING:
      return t('settings.user.bot.runtime.stopping')
    case BOT_RUNTIME_STATE.ERROR:
      return t('settings.user.bot.runtime.error')
    case BOT_RUNTIME_STATE.STOPPED:
      return t('settings.user.bot.runtime.stopped')
    case BOT_RUNTIME_STATE.NOT_BOUND:
      return t('settings.user.bot.runtime.notBound')
    default:
      return t('settings.user.bot.runtime.unknown')
  }
})
const runtimeTagType = computed(() => {
  switch (props.status.runtimeState) {
    case BOT_RUNTIME_STATE.RUNNING:
      return 'success'
    case BOT_RUNTIME_STATE.ERROR:
      return 'danger'
    case BOT_RUNTIME_STATE.NOT_BOUND:
      return 'info'
    default:
      return 'warning'
  }
})
const loginStatusText = computed(() => {
  switch (props.loginState?.status) {
    case WEIXIN_BOT_LOGIN_STATUS.SCANNED:
      return t('settings.user.bot.login.scanned')
    case WEIXIN_BOT_LOGIN_STATUS.NEED_VERIFY_CODE:
      return t('settings.user.bot.login.needVerifyCode')
    case WEIXIN_BOT_LOGIN_STATUS.CONFIRMED:
      return t('settings.user.bot.login.confirmed')
    case WEIXIN_BOT_LOGIN_STATUS.EXPIRED:
      return t('settings.user.bot.login.expired')
    case WEIXIN_BOT_LOGIN_STATUS.ERROR:
      return t('settings.user.bot.login.error')
    case WEIXIN_BOT_LOGIN_STATUS.WAITING:
    default:
      return t('settings.user.bot.login.waiting')
  }
})
const canSubmitVerifyCode = computed(() =>
  props.loginState?.status === WEIXIN_BOT_LOGIN_STATUS.NEED_VERIFY_CODE
  && Boolean(verifyCode.value.trim()),
)
const canStartRuntime = computed(() =>
  props.status.bound
  && props.status.runtimeState !== BOT_RUNTIME_STATE.RUNNING
  && props.status.runtimeState !== BOT_RUNTIME_STATE.STARTING,
)
const canStopRuntime = computed(() =>
  props.status.runtimeState === BOT_RUNTIME_STATE.RUNNING
  || props.status.runtimeState === BOT_RUNTIME_STATE.STARTING,
)
</script>

<template>
  <ElCard shadow="never" class="bots-section">
    <UserSettingsSectionHeader
      :title="t('settings.user.bot.title')"
      :description="t('settings.user.bot.description')"
    />

    <div class="bots-section__body grid gap-3">
      <ElSkeleton v-if="props.isLoading" animated>
        <template #template>
          <div class="bots-section__status flex flex-wrap items-center justify-between gap-4 rounded-[1rem] p-4">
            <div class="flex min-w-0 flex-1 items-center gap-3">
              <ElSkeletonItem variant="circle" class="h-10 w-10 shrink-0" />
              <div class="grid flex-1 gap-2">
                <ElSkeletonItem variant="h3" class="max-w-28" />
                <ElSkeletonItem variant="text" class="max-w-52" />
              </div>
            </div>
            <ElSkeletonItem variant="button" class="h-8 max-w-28" />
          </div>
        </template>
      </ElSkeleton>

      <template v-else>
        <div class="bots-section__status flex flex-wrap items-center justify-between gap-4 rounded-[1rem] p-4">
          <div class="flex min-w-0 items-center gap-3">
            <span class="bots-section__icon flex h-10 w-10 shrink-0 items-center justify-center rounded-[0.875rem]">
              <SvgIcon category="brand" icon="brand-weixin" size="1.45rem" />
            </span>
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <strong class="text-base text-main">{{ t('settings.user.bot.name') }}</strong>
                <ElTag v-if="props.status.bound" size="small" :type="runtimeTagType" effect="light">
                  {{ runtimeText }}
                </ElTag>
              </div>
              <div class="mt-1 text-[0.8125rem] leading-5 text-secondary">
                {{ props.status.accountId ? t('settings.user.bot.accountId', { id: props.status.accountId }) : t('settings.user.bot.notBoundAccount') }}
              </div>
            </div>
          </div>

          <div class="flex flex-wrap gap-2">
            <ElButton :loading="props.isStartingLogin" @click="emit('startLogin')">
              <SvgIcon category="ui" icon="link" size="0.95rem" class="mr-1.5" />
              {{ props.status.bound ? t('settings.user.bot.rebind') : t('settings.user.bot.bind') }}
            </ElButton>
            <ElButton
              v-if="canStartRuntime"
              :loading="props.isStartingBot"
              @click="emit('startRuntime')"
            >
              <SvgIcon category="ui" icon="sync-refresh" size="0.95rem" class="mr-1.5" />
              {{ t('settings.user.bot.start') }}
            </ElButton>
            <ElButton
              v-if="canStopRuntime"
              :loading="props.isStoppingBot"
              @click="emit('stopRuntime')"
            >
              {{ t('settings.user.bot.stop') }}
            </ElButton>
            <ElButton
              v-if="props.status.bound"
              type="danger"
              plain
              :loading="props.isDisconnecting"
              @click="emit('disconnect')"
            >
              <SvgIcon category="ui" icon="trash-can" size="0.95rem" class="mr-1.5" />
              {{ t('settings.user.bot.disconnect') }}
            </ElButton>
          </div>
        </div>

        <ElAlert
          v-if="props.status.lastError"
          type="error"
          show-icon
          :closable="false"
          :title="props.status.lastError"
        />
      </template>
    </div>

    <ElDialog
      v-model="loginVisible"
      :title="t('settings.user.bot.bindDialogTitle')"
      width="24rem"
      align-center
      class="bots-section__dialog"
    >
      <div class="bots-section__qr-panel flex flex-col items-center gap-4">
        <div class="bots-section__qr-frame flex h-[17.5rem] w-[17.5rem] items-center justify-center rounded-[1rem]">
          <img
            v-if="props.loginState?.qrCodeDataUrl"
            :src="props.loginState.qrCodeDataUrl"
            :alt="t('settings.user.bot.qrAlt')"
            class="h-[16.5rem] w-[16.5rem]"
          >
          <ElSkeleton v-else animated class="w-full px-4">
            <template #template>
              <ElSkeletonItem variant="image" class="h-[16.5rem] w-[16.5rem]" />
            </template>
          </ElSkeleton>
        </div>

        <div class="text-center">
          <div class="text-sm font-medium text-main">
            {{ loginStatusText }}
          </div>
          <div class="mt-1 text-[0.8125rem] leading-5 text-secondary">
            {{ props.loginState?.message ?? t('settings.user.bot.qrCreating') }}
          </div>
        </div>

        <div
          v-if="props.loginState?.status === WEIXIN_BOT_LOGIN_STATUS.NEED_VERIFY_CODE"
          class="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2"
        >
          <ElInput
            v-model="verifyCode"
            :placeholder="t('settings.user.bot.verifyCodePlaceholder')"
            maxlength="12"
            @keyup.enter="emit('submitVerifyCode')"
          />
          <ElButton
            type="primary"
            :disabled="!canSubmitVerifyCode"
            :loading="props.isSubmittingVerifyCode"
            @click="emit('submitVerifyCode')"
          >
            {{ t('settings.user.bot.submit') }}
          </ElButton>
        </div>
      </div>

      <template #footer>
        <div class="flex items-center justify-between gap-3">
          <span class="text-[0.8125rem] text-secondary">
            {{ props.isPollingLogin ? t('settings.user.bot.polling') : t('settings.user.bot.qrTtl') }}
          </span>
          <ElButton @click="loginVisible = false">
            {{ t('settings.user.bot.close') }}
          </ElButton>
        </div>
      </template>
    </ElDialog>
  </ElCard>
</template>

<style scoped lang="scss">
.bots-section {
  border-color: color-mix(in srgb, var(--brand-border-base) 85%, transparent);

  &__status,
  &__qr-frame {
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 78%, transparent);
    background: color-mix(in srgb, var(--brand-fill-lighter) 72%, transparent);
  }

  &__icon {
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
    background: color-mix(in srgb, var(--brand-primary) 5%, var(--brand-bg-surface));
    color: var(--brand-text-primary);
  }
}
</style>
