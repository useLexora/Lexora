import type {
  WeixinBotBindingStatus,
  WeixinBotLoginStartResponse,
  WeixinBotLoginStatusResponse,
} from '@/apis/bot-accounts'
import {
  BOT_RUNTIME_STATE,
  WEIXIN_BOT_LOGIN_STATUS,
} from '@haohaoxue/lexora-contracts/bot'
import { CHAT_SESSION_CHANNEL } from '@haohaoxue/lexora-contracts/chat/constants'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  disconnectWeixinBot,
  getWeixinBotLoginStatus,
  getWeixinBotStatus,
  startWeixinBot,
  startWeixinBotLogin,
  stopWeixinBot,
  submitWeixinBotVerifyCode,
} from '@/apis/bot-accounts'
import { ElMessage, ElMessageBox } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

type WeixinLoginState = WeixinBotLoginStartResponse | WeixinBotLoginStatusResponse

const LOGIN_POLL_DELAY_MS = 800

function createDefaultStatus(): WeixinBotBindingStatus {
  return {
    channel: CHAT_SESSION_CHANNEL.WEIXIN_BOT,
    bound: false,
    accountId: null,
    externalUserId: null,
    runtimeState: BOT_RUNTIME_STATE.NOT_BOUND,
    lastError: null,
    lastLog: null,
    lastStartedAt: null,
    lastStoppedAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    updatedAt: null,
  }
}

export function useSettingsWeixinBot() {
  const { t } = useI18n({ useScope: 'global' })
  const status = shallowRef<WeixinBotBindingStatus>(createDefaultStatus())
  const loginState = shallowRef<WeixinLoginState | null>(null)
  const loginDialogVisible = shallowRef(false)
  const verifyCode = shallowRef('')
  const isLoading = shallowRef(false)
  const isStartingLogin = shallowRef(false)
  const isPollingLogin = shallowRef(false)
  const isSubmittingVerifyCode = shallowRef(false)
  const isStartingBot = shallowRef(false)
  const isStoppingBot = shallowRef(false)
  const isDisconnecting = shallowRef(false)
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  const isLoginTerminal = computed(() =>
    loginState.value?.status === WEIXIN_BOT_LOGIN_STATUS.CONFIRMED
    || loginState.value?.status === WEIXIN_BOT_LOGIN_STATUS.EXPIRED
    || loginState.value?.status === WEIXIN_BOT_LOGIN_STATUS.ERROR,
  )

  watch(loginDialogVisible, (visible) => {
    if (!visible) {
      clearLoginPoll()
    }
  })

  onScopeDispose(clearLoginPoll)

  async function loadWeixinStatus(options: { silent?: boolean } = {}) {
    isLoading.value = true

    try {
      status.value = await getWeixinBotStatus()
    }
    catch (error) {
      if (!options.silent) {
        ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.user.bot.statusFailed')))
      }
    }
    finally {
      isLoading.value = false
    }
  }

  async function startLogin() {
    isStartingLogin.value = true
    clearLoginPoll()

    try {
      loginState.value = await startWeixinBotLogin()
      verifyCode.value = ''
      loginDialogVisible.value = true
      scheduleLoginPoll()
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.user.bot.bindFailed')))
    }
    finally {
      isStartingLogin.value = false
    }
  }

  async function pollLoginStatus() {
    const loginId = loginState.value?.loginId
    if (!loginId || isLoginTerminal.value || !loginDialogVisible.value) {
      return
    }

    isPollingLogin.value = true

    try {
      const nextState = await getWeixinBotLoginStatus(loginId)
      applyLoginState(nextState)

      if (!isLoginTerminal.value) {
        scheduleLoginPoll()
      }
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.user.bot.statusFailed')))
      scheduleLoginPoll(2500)
    }
    finally {
      isPollingLogin.value = false
    }
  }

  async function submitVerifyCode() {
    const loginId = loginState.value?.loginId
    const code = verifyCode.value.trim()
    if (!loginId || !code) {
      ElMessage.warning(t('settings.user.bot.verifyCodeRequired'))
      return
    }

    isSubmittingVerifyCode.value = true

    try {
      const nextState = await submitWeixinBotVerifyCode(loginId, {
        verifyCode: code,
      })
      applyLoginState(nextState)
      if (!isLoginTerminal.value) {
        scheduleLoginPoll()
      }
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.user.bot.submitCodeFailed')))
    }
    finally {
      isSubmittingVerifyCode.value = false
    }
  }

  async function startRuntime() {
    isStartingBot.value = true

    try {
      status.value = await startWeixinBot()
      ElMessage.success(t('settings.user.bot.started'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.user.bot.startFailed')))
    }
    finally {
      isStartingBot.value = false
    }
  }

  async function stopRuntime() {
    isStoppingBot.value = true

    try {
      status.value = await stopWeixinBot()
      ElMessage.success(t('settings.user.bot.stopped'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.user.bot.stopFailed')))
    }
    finally {
      isStoppingBot.value = false
    }
  }

  async function disconnect() {
    const confirmed = await ElMessageBox.confirm(
      t('settings.user.bot.disconnectDescription'),
      t('settings.user.bot.disconnectTitle'),
      {
        type: 'warning',
        confirmButtonText: t('settings.user.bot.disconnectConfirm'),
        cancelButtonText: t('settings.user.bot.disconnectCancel'),
      },
    ).then(() => true).catch(() => false)

    if (!confirmed) {
      return
    }

    isDisconnecting.value = true

    try {
      await disconnectWeixinBot()
      status.value = createDefaultStatus()
      ElMessage.success(t('settings.user.bot.disconnected'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.user.bot.disconnectFailed')))
    }
    finally {
      isDisconnecting.value = false
    }
  }

  function applyLoginState(nextState: WeixinLoginState) {
    loginState.value = loginState.value ? { ...loginState.value, ...nextState } : nextState

    if ('account' in nextState && nextState.account) {
      status.value = nextState.account
    }

    if (nextState.status === WEIXIN_BOT_LOGIN_STATUS.CONFIRMED) {
      ElMessage.success(t('settings.user.bot.bound'))
      clearLoginPoll()
      loginDialogVisible.value = false
    }
  }

  function scheduleLoginPoll(delay = LOGIN_POLL_DELAY_MS) {
    clearLoginPoll()
    pollTimer = setTimeout(() => {
      pollTimer = null
      void pollLoginStatus()
    }, delay)
  }

  function clearLoginPoll() {
    if (!pollTimer) {
      return
    }

    clearTimeout(pollTimer)
    pollTimer = null
  }

  return {
    disconnect,
    isDisconnecting,
    isLoading,
    isPollingLogin,
    isStartingBot,
    isStartingLogin,
    isStoppingBot,
    isSubmittingVerifyCode,
    loadWeixinStatus,
    loginDialogVisible,
    loginState,
    startLogin,
    startRuntime,
    status,
    stopRuntime,
    submitVerifyCode,
    verifyCode,
  }
}
