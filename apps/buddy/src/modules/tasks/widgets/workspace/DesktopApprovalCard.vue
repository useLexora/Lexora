<script setup lang="ts">
import type { LocalApproval } from '@buddy-shared/permissions/approvalApi'
import type { ApprovalGrantScope, ApprovalReuseScope } from '@buddy-shared/permissions/approvalReviewPayload'
import type { DropdownOption } from 'naive-ui'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ChatApprovalDecision } from '@/modules/tasks/model/runs/typing'
import { ChevronUp16Regular, ShieldError20Regular, Warning20Regular } from '@vicons/fluent'
import { useIntervalFn, useNow } from '@vueuse/core'
import { NButton, NDropdown } from 'naive-ui'
import { computed, h, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { projectApprovalDecisions } from '../../model/approvals/approvalDecisions'
import { translateSystemAction } from '../../model/approvals/systemActionPresentation'
import { useExecutionTree } from '../../state/runs/chatExecutionContext'
import BuddyExecutionIdentity from '../executions/BuddyExecutionIdentity.vue'
import { executionLabels } from '../executions/executionLabels'
import DesktopApprovalDetails from './DesktopApprovalDetails.vue'

const props = defineProps<{
  approval: LocalApproval
  language: BuddyLocale
  resolvingAction: ChatApprovalDecision | null
}>()
const emit = defineEmits<{ approve: [scope: ApprovalGrantScope], deny: [] }>()
const { t } = useBuddyI18n(() => props.language)
const tree = useExecutionTree()
const execution = computed(() => tree?.records.value.find(record => record.runId === props.approval.runId))
const labels = computed(() => executionLabels(props.language))
const browserEffectKeys = {
  'account-change': 'desktop.approval.browser.effect.accountChange',
  'authorize': 'desktop.approval.browser.effect.authorize',
  'delete': 'desktop.approval.browser.effect.delete',
  'publish': 'desktop.approval.browser.effect.publish',
  'purchase': 'desktop.approval.browser.effect.purchase',
  'send': 'desktop.approval.browser.effect.send',
  'submit': 'desktop.approval.browser.effect.submit',
} as const
const now = useNow({ scheduler: update => useIntervalFn(update, 1000) })
const decisionState = computed(() => projectApprovalDecisions(props.approval, now.value.getTime()))
const review = computed(() => decisionState.value.review)
const systemEffect = computed(() => {
  if (review.value?.card !== 'system-action')
    return ''
  return translateSystemAction(props.language, review.value.action)
})
const browserEffect = computed(() => {
  if (review.value?.card !== 'browser-action')
    return ''
  if (review.value.risk === 'interaction')
    return t('desktop.approval.browser.effect.interaction')
  return review.value.effect
    ? t(browserEffectKeys[review.value.effect])
    : t('desktop.approval.browser.effect.unknown')
})
const approvalOperation = computed(() => (
  (review.value?.card === 'network-permission' ? t(`desktop.approval.network.${review.value.operation}`) : '')
  || systemEffect.value
  || browserEffect.value
  || (props.approval.kind === 'mcp' && props.approval.summary.trim())
  || t(`desktop.approval.kind.${props.approval.kind}`)
))
const approvalTitle = computed(() => review.value?.card === 'sandbox-network'
  ? t('desktop.approval.sandbox.networkTitle')
  : t('desktop.approval.title', { operation: approvalOperation.value }))
const approvalDescription = computed(() => (
  review.value?.card === 'sandbox-directory'
    ? t('desktop.approval.sandbox.directoryScope')
    : review.value?.card === 'sandbox-network'
      ? t('desktop.approval.sandbox.networkScope')
      : review.value?.card === 'shell'
        ? t(review.value.context?.reason === 'sandbox-bypass'
            ? 'desktop.approval.sandbox.hostScope'
            : review.value.context?.boundary === 'sandbox'
              ? 'desktop.approval.sandbox.isolatedScope'
              : 'desktop.approval.currentWorkspace')
        : review.value?.card === 'browser-action'
          ? t('desktop.approval.browser.scopeReview')
          : review.value?.card === 'paths' && review.value.access === 'render'
            ? t('desktop.approval.paths.renderDescription')
            : review.value?.card === 'paths' && review.value.grant
              ? t('desktop.approval.paths.grantDescription')
              : t('desktop.approval.scopeReview')
))
const approveActionLabel = computed(() => review.value?.card === 'sandbox-directory'
  ? t('desktop.approval.sandbox.approveDirectory')
  : t('approvalAction.approve'))
const reviewExpired = computed(() => decisionState.value.expired)
const canApprove = computed(() => decisionState.value.canApprove)
const canDeny = computed(() => decisionState.value.canDeny)
const fullOperation = computed(() => props.approval.review ? JSON.stringify(props.approval.review.body, null, 2) : '')
const showFullOperation = shallowRef(false)
const canPersist = computed(() => decisionState.value.canPersist)
const persistentNotice = computed(() => {
  const value = review.value
  if (!canPersist.value || !value)
    return ''
  if (value.card === 'network-permission')
    return t('desktop.approval.network.persistNotice', { host: value.host, operation: t(`desktop.approval.network.${value.operation}`) })
  const grant = value.card === 'sandbox-directory' ? value.persistentDirectory : value.card === 'paths' ? value.grant : null
  return grant ? t(grant.owner === 'space' ? 'desktop.approval.paths.grantSpace' : 'desktop.approval.paths.grantConversation', { root: grant.root }) : ''
})
const headingId = computed(() => `desktop-approval-${props.approval.id}-title`)
const isResolving = computed(() => props.resolvingAction !== null)
const scopeMenuOpen = shallowRef(false)
const reuseScopes = computed(() => decisionState.value.reuseScopes)
const reuseOptions = computed<DropdownOption[]>(() => [
  ...(reuseScopes.value.length
    ? [{
        type: 'group' as const,
        key: 'temporary',
        label: t('approvalAction.temporary'),
        children: reuseScopes.value.map(scope => ({ key: scope, label: scopeLabel(scope) })),
      }]
    : []),
  ...(canPersist.value
    ? [{
        type: 'group' as const,
        key: 'saved',
        label: t('approvalAction.saved'),
        children: [{
          key: 'persistent',
          label: t(review.value?.card === 'network-permission' ? 'approvalAction.saveWebsite' : 'approvalAction.saveDirectory'),
        }],
      }]
    : []),
])
function scopeLabel(scope: ApprovalReuseScope) {
  if (scope === 'turn')
    return t('approvalAction.approveFor.turn')
  if (scope === 'operation') {
    if (props.approval.kind === 'mcp')
      return t('approvalAction.reuse.tool')
    return t('approvalAction.approveFor.operation')
  }
  switch (review.value?.card) {
    case 'network-permission': return t('approvalAction.reuse.networkTarget')
    case 'sandbox-network': return t('approvalAction.reuse.networkTarget')
    case 'network-target': return t('approvalAction.reuse.website')
    case 'web': return t(review.value.operation === 'search' ? 'approvalAction.reuse.searchProvider' : 'approvalAction.reuse.website')
    case 'browser-action': return t('approvalAction.reuse.browserSite')
    case 'shell': return t('approvalAction.reuse.shellDirectory')
    case 'paths': return t('approvalAction.reuse.directory')
    case 'system-action': return t('approvalAction.reuse.systemTarget')
    case 'automation': return t('approvalAction.reuse.automation')
    default: return t(props.approval.kind === 'mcp' ? 'approvalAction.reuse.connector' : 'approvalAction.approveFor.source')
  }
}
function approveForScope(scope: string | number) {
  if (!canApprove.value)
    return
  if (scope === 'persistent' && canPersist.value)
    emit('approve', 'persistent')
  else if (typeof scope === 'string' && reuseScopes.value.includes(scope as ApprovalReuseScope))
    emit('approve', scope as ApprovalReuseScope)
}
function renderScopeLabel(option: DropdownOption) {
  if (option.key !== 'turn')
    return option.label as string
  return h('span', {
    class: 'desktop-approval-card__turn-option',
    style: { color: 'var(--buddy-status-danger-text)', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' },
  }, [
    h(DesktopIcon, { component: ShieldError20Regular }),
    option.label as string,
  ])
}
</script>

<template>
  <article
    class="desktop-approval-card grid gap-[0.7rem] border-1 border-solid border-border rounded-[0.65rem] bg-raised py-[0.8rem] px-[0.85rem]"
    :aria-busy="isResolving"
    :aria-labelledby="headingId"
  >
    <header class="grid grid-cols-[auto_minmax(0,_1fr)] items-center gap-[0.6rem]">
      <DesktopIcon class="desktop-approval-card__pending-icon" :component="Warning20Regular" />
      <div class="grid gap-[0.12rem]">
        <strong :id="headingId" class="text-strong text-[0.84rem] font-600 leading-[1.4] [overflow-wrap:anywhere]">
          {{ approvalTitle }}
        </strong>
        <BuddyExecutionIdentity v-if="execution" :execution="execution" :language="language" />
        <span v-else class="text-muted text-[12px] break-all">{{ labels.executionRecord }}{{ approval.runId }}</span>
        <span class="text-muted text-[length:var(--buddy-chat-caption-font-size)] leading-[var(--buddy-chat-caption-line-height)]">
          {{ approvalDescription }}
        </span>
        <span v-if="reuseScopes.length" class="text-muted text-[length:var(--buddy-chat-caption-font-size)] leading-[var(--buddy-chat-caption-line-height)]">
          {{ t('approvalAction.reuse.lifetime') }}
        </span>
      </div>
    </header>
    <p v-if="persistentNotice" class="text-muted text-[length:var(--buddy-chat-caption-font-size)] leading-[var(--buddy-chat-caption-line-height)]">
      {{ persistentNotice }}
    </p>
    <DesktopApprovalDetails :review="review" :language="language" :browser-effect="browserEffect" :system-effect="systemEffect" />
    <p v-if="approval.review === null" class="text-muted text-[length:var(--buddy-chat-caption-font-size)]">
      {{ t('desktop.approval.unsupported') }}
    </p>
    <p v-if="reviewExpired" class="text-muted text-[length:var(--buddy-chat-caption-font-size)]">
      {{ t('desktop.approval.expired') }}
    </p>
    <section v-if="approval.review" class="grid gap-2">
      <p v-if="!approval.review.complete" class="text-muted text-[length:var(--buddy-chat-caption-font-size)]">
        {{ t('desktop.approval.incomplete') }}
      </p>
      <NButton size="small" secondary :aria-expanded="showFullOperation" @click="showFullOperation = !showFullOperation">
        {{ t('desktop.approval.fullOperation') }}
      </NButton>
      <pre v-if="showFullOperation" class="m-0 max-h-80 overflow-auto rounded-2 bg-subtle p-3 text-[length:var(--buddy-chat-caption-font-size)] whitespace-pre-wrap [overflow-wrap:anywhere]">{{ fullOperation }}</pre>
    </section>
    <footer class="flex items-center justify-end gap-[0.6rem]">
      <div class="flex items-center justify-end gap-2">
        <NButton
          size="small"
          type="error"
          :disabled="isResolving || !canDeny"
          :loading="resolvingAction === 'deny'"
          @click="emit('deny')"
        >
          {{ t('approvalAction.deny') }}
        </NButton>
        <div class="flex items-stretch">
          <NButton
            class="desktop-approval-card__approve-button"
            size="small"
            type="primary"
            :disabled="isResolving || !canApprove"
            :loading="resolvingAction === 'once'"
            @click="emit('approve', 'once')"
          >
            {{ approveActionLabel }}
          </NButton>
          <NDropdown
            v-if="reuseOptions.length"
            v-model:show="scopeMenuOpen"
            trigger="click"
            placement="top-end"
            :disabled="isResolving || !canApprove"
            :options="reuseOptions"
            :render-label="renderScopeLabel"
            @select="approveForScope"
          >
            <NButton
              class="desktop-approval-card__scope-button"
              size="small"
              type="primary"
              :disabled="isResolving || !canApprove"
              :loading="resolvingAction !== null && resolvingAction !== 'once' && resolvingAction !== 'deny'"
              :aria-label="t('approvalAction.selectScope')"
            >
              <template #icon>
                <DesktopIcon
                  class="desktop-approval-card__scope-chevron"
                  :class="{ 'is-open': scopeMenuOpen }"
                  :component="ChevronUp16Regular"
                />
              </template>
            </NButton>
          </NDropdown>
        </div>
      </div>
    </footer>
  </article>
</template>

<style scoped lang="scss">
.desktop-approval-card__pending-icon {
  align-self: start;
  color: var(--buddy-status-warning-text);
  font-size: 1.05rem;
  margin-top: 0.05rem;
}

.desktop-approval-card pre {
  max-height: 9rem;
  margin: 0;
  overflow: auto;
  color: var(--buddy-chat-code-color);
  font-family: var(--buddy-font-mono);
  font-size: var(--buddy-chat-code-font-size);
  line-height: var(--buddy-chat-code-line-height);
  white-space: pre-wrap;
}

.desktop-approval-card p {
  margin: 0;
}

.desktop-approval-card__approve-button {
  border-bottom-right-radius: 0;
  border-top-right-radius: 0;
}

.desktop-approval-card__scope-button {
  min-width: 1.9rem;
  margin-left: 1px;
  border-bottom-left-radius: 0;
  border-top-left-radius: 0;
  padding-inline: 0.35rem;
}

.desktop-approval-card__scope-chevron {
  transition: transform 80ms ease;
}

.desktop-approval-card__scope-chevron.is-open {
  transform: rotate(180deg);
}
</style>
