<script setup lang="ts">
import type { LocalApproval } from '@buddy-shared/permissions/approvalApi'
import type { ApprovalGrantScope, ApprovalReuseScope, ApprovalReviewPayload } from '@buddy-shared/permissions/approvalReviewPayload'
import type { BuddyExecutionProfile } from '@buddy-shared/permissions/executionProfile'
import type { DropdownOption } from 'naive-ui'
import type { CSSProperties } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ChatApprovalDecision } from '@/modules/tasks/model/runs/typing'
import { approvalReviewPayloadSchema } from '@buddy-shared/permissions/approvalReviewPayload'
import { ChevronUp16Regular, ShieldError20Regular, Warning20Regular } from '@vicons/fluent'
import { NButton, NDescriptions, NDescriptionsItem, NDropdown } from 'naive-ui'
import { computed, h, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { translateSystemAction, translateSystemInterruption } from '../../model/approvals/systemActionPresentation'

const props = defineProps<{
  approval: LocalApproval
  language: BuddyLocale
  resolvingAction: ChatApprovalDecision | null
}>()
const emit = defineEmits<{ approve: [scope: ApprovalGrantScope], deny: [] }>()
const { t } = useBuddyI18n(() => props.language)
const detailsProps = {
  bordered: true,
  column: 1,
  contentStyle: { overflowWrap: 'anywhere', verticalAlign: 'middle', whiteSpace: 'pre-wrap' } satisfies CSSProperties,
  labelPlacement: 'left' as const,
  labelStyle: { overflowWrap: 'anywhere', verticalAlign: 'middle', width: '8rem' } satisfies CSSProperties,
  size: 'small' as const,
}
const automationOperationKeys = {
  delete: 'desktop.chat.processToolAutomationDelete',
  pause: 'desktop.chat.processToolAutomationPause',
  resume: 'desktop.chat.processToolAutomationResume',
  run_now: 'desktop.chat.processToolAutomationRunNow',
  upsert: 'desktop.chat.processToolAutomationUpsert',
} as const
const browserEffectKeys = {
  'account-change': 'desktop.approval.browser.effect.accountChange',
  'authorize': 'desktop.approval.browser.effect.authorize',
  'delete': 'desktop.approval.browser.effect.delete',
  'publish': 'desktop.approval.browser.effect.publish',
  'purchase': 'desktop.approval.browser.effect.purchase',
  'send': 'desktop.approval.browser.effect.send',
  'submit': 'desktop.approval.browser.effect.submit',
} as const
const executionProfileKeys: Record<BuddyExecutionProfile, 'desktop.chat.permissionModePolicy' | 'desktop.chat.executionProfileFull' | 'desktop.chat.executionProfileReadOnly'> = {
  full_access: 'desktop.chat.executionProfileFull',
  read_only: 'desktop.chat.executionProfileReadOnly',
  workspace_write: 'desktop.chat.permissionModePolicy',
}
const review = computed<ApprovalReviewPayload | null>(() => {
  const parsed = approvalReviewPayloadSchema.safeParse(props.approval.payload)
  return parsed.success ? parsed.data : null
})
const shellReason = computed(() => (
  review.value?.card === 'shell' && review.value.context
    ? t(`desktop.approval.shell.reason.${review.value.context.reason}`)
    : ''
))
const systemEffect = computed(() => {
  if (review.value?.card !== 'system-action')
    return ''
  return translateSystemAction(props.language, review.value.action)
})
const systemInterruption = computed(() => {
  if (review.value?.card !== 'system-action')
    return ''
  return translateSystemInterruption(props.language, review.value.interruption)
})
const automationOperation = computed(() => {
  if (review.value?.card !== 'automation')
    return ''
  return t(automationOperationKeys[review.value.operation])
})
const browserEffect = computed(() => {
  if (review.value?.card !== 'browser-action')
    return ''
  return review.value.effect
    ? t(browserEffectKeys[review.value.effect])
    : t('desktop.approval.browser.effect.unknown')
})
const pathGrant = computed(() => (
  review.value?.card === 'paths' ? review.value.grant : null
))
const grantNotice = computed(() => {
  const grant = pathGrant.value
  if (!grant)
    return ''
  return t(grant.owner === 'space'
    ? 'desktop.approval.paths.grantSpace'
    : 'desktop.approval.paths.grantConversation', { root: grant.root })
})
const browserAction = computed(() => {
  if (review.value?.card !== 'browser-action')
    return ''
  if (review.value.action === 'click')
    return t('desktop.approval.browser.action.click')
  if (review.value.key === 'Enter')
    return t('desktop.approval.browser.action.pressEnter')
  if (review.value.key === 'Space')
    return t('desktop.approval.browser.action.pressSpace')
  return t('desktop.approval.browser.action.press')
})
const approvalOperation = computed(() => (
  systemEffect.value
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
const approveActionLabel = computed(() => (
  review.value?.card === 'sandbox-directory'
    ? t('desktop.approval.sandbox.approveDirectory')
    : review.value?.card === 'paths' && review.value.grant
      ? t('desktop.approval.paths.approveAndGrantAction')
      : t('approvalAction.approve')
))
const headingId = computed(() => `desktop-approval-${props.approval.id}-title`)
const isResolving = computed(() => props.resolvingAction !== null)
const scopeMenuOpen = shallowRef(false)
const reuseScopes = computed<readonly ApprovalReuseScope[]>(() => (
  review.value?.reuseScopes
  ?? (review.value?.allowForTurn ? ['turn'] : [])
))
const reuseOptions = computed<DropdownOption[]>(() => reuseScopes.value.map(scope => ({
  key: scope,
  label: scopeLabel(scope),
})))
function scopeLabel(scope: ApprovalReuseScope) {
  if (scope === 'turn')
    return t('approvalAction.approveFor.turn')
  if (scope === 'operation') {
    if (props.approval.kind === 'mcp')
      return t('approvalAction.reuse.tool')
    return t('approvalAction.approveFor.operation')
  }
  switch (review.value?.card) {
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
  if (typeof scope === 'string' && reuseScopes.value.includes(scope as ApprovalReuseScope))
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
        <span class="text-muted text-[length:var(--buddy-chat-caption-font-size)] leading-[var(--buddy-chat-caption-line-height)]">
          {{ approvalDescription }}
        </span>
        <span v-if="reuseScopes.length" class="text-muted text-[length:var(--buddy-chat-caption-font-size)] leading-[var(--buddy-chat-caption-line-height)]">
          {{ t('approvalAction.reuse.lifetime') }}
        </span>
      </div>
    </header>
    <section
      v-if="review?.card === 'automation'"
      class="desktop-approval-card__details"
    >
      <NDescriptions v-bind="detailsProps">
        <NDescriptionsItem :label="t('desktop.approval.automation.operation')">
          {{ automationOperation }}
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.automation.name')">
          {{ review.name }}
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.automation.schedule')">
          {{ review.scheduleSummary }}
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.automation.timezone')">
          {{ review.timezone }}
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.automation.prompt')">
          {{ review.promptSummary }}
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.automation.space')">
          {{ review.spaceId ?? t('desktop.approval.automation.noSpace') }}
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.automation.model')">
          {{ review.modelMode }}
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.automation.executionProfile')">
          {{ t(executionProfileKeys[review.executionProfile]) }}
        </NDescriptionsItem>
      </NDescriptions>
    </section>
    <section
      v-else-if="review?.card === 'sandbox-directory'"
      class="desktop-approval-card__details"
    >
      <NDescriptions v-bind="detailsProps">
        <NDescriptionsItem :label="t('desktop.approval.target')">
          <code>{{ review.path }}</code>
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.authorizationBoundary')">
          {{ t(review.access === 'read' ? 'desktop.approval.sandbox.directoryRead' : 'desktop.approval.sandbox.directoryWrite') }}
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.reason')">
          {{ review.reason }}
        </NDescriptionsItem>
      </NDescriptions>
    </section>
    <section
      v-else-if="review?.card === 'sandbox-network'"
      class="desktop-approval-card__details"
    >
      <NDescriptions v-bind="detailsProps">
        <NDescriptionsItem :label="t('desktop.approval.target')">
          <code>{{ review.host }} · {{ review.port }}</code>
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.runCommand')">
          <pre>{{ review.command }}</pre>
        </NDescriptionsItem>
      </NDescriptions>
    </section>
    <section
      v-else-if="review?.card === 'web'"
      class="desktop-approval-card__details"
    >
      <NDescriptions v-bind="detailsProps">
        <NDescriptionsItem :label="t(review.operation === 'search' ? 'desktop.approval.web.query' : 'desktop.approval.web.url')">
          {{ review.target }}
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.web.provider')">
          {{ review.provider ?? t('desktop.approval.web.providerAuto') }}
        </NDescriptionsItem>
      </NDescriptions>
    </section>
    <section
      v-else-if="review?.card === 'network-target'"
      class="desktop-approval-card__details"
    >
      <NDescriptions v-bind="detailsProps">
        <NDescriptionsItem :label="t('desktop.approval.target')">
          <code>{{ review.target }}</code>
        </NDescriptionsItem>
      </NDescriptions>
    </section>
    <section
      v-else-if="review?.card === 'system-action'"
      class="desktop-approval-card__details"
    >
      <NDescriptions v-bind="detailsProps">
        <NDescriptionsItem :label="t('desktop.approval.target')">
          {{ review.target.displayName }}
        </NDescriptionsItem>
        <NDescriptionsItem v-if="review.target.pid" label="PID">
          {{ review.target.pid }}
        </NDescriptionsItem>
        <NDescriptionsItem v-if="review.target.serviceId" :label="t('desktop.approval.systemUnit')">
          {{ review.target.serviceId }}
        </NDescriptionsItem>
        <NDescriptionsItem v-if="review.target.startedAt" :label="t('desktop.approval.processStartedAt')">
          {{ review.target.startedAt }}
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.effect')">
          {{ systemEffect }}
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.reason')">
          {{ review.reason }}
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.interruption')">
          {{ systemInterruption }}
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.expiresAt')">
          {{ review.expiresAt }}
        </NDescriptionsItem>
      </NDescriptions>
    </section>
    <section
      v-else-if="review?.card === 'browser-action'"
      class="desktop-approval-card__details"
    >
      <NDescriptions v-bind="detailsProps">
        <NDescriptionsItem :label="t('desktop.approval.browser.origin')">
          <code>{{ review.origin }}</code>
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.effect')">
          {{ browserEffect }}
        </NDescriptionsItem>
        <NDescriptionsItem v-if="review.targetName" :label="t('desktop.approval.browser.pageTarget')">
          {{ review.targetName }}
        </NDescriptionsItem>
        <NDescriptionsItem v-if="review.targetRole" :label="t('desktop.approval.browser.role')">
          {{ review.targetRole }}
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('desktop.approval.browser.action')">
          {{ browserAction }}
        </NDescriptionsItem>
      </NDescriptions>
    </section>
    <section v-else-if="review?.card === 'shell'" class="desktop-approval-card__details">
      <NDescriptions v-bind="detailsProps">
        <NDescriptionsItem :label="t('desktop.approval.runCommand')">
          <pre>{{ review.command }}</pre>
        </NDescriptionsItem>
        <NDescriptionsItem v-if="review.context" :label="t('desktop.approval.shell.approvalReason')">
          {{ shellReason }}
        </NDescriptionsItem>
        <NDescriptionsItem v-if="review.context" :label="t('desktop.approval.workingDirectory')">
          {{ review.context.cwd }}
        </NDescriptionsItem>
      </NDescriptions>
    </section>
    <div v-else-if="review?.card === 'paths'" class="border border-solid border-border rounded-2 bg-subtle py-[0.65rem] px-[0.7rem]">
      <ul class="desktop-approval-card__paths">
        <li v-for="target in review.targets" :key="target.path">
          <code>{{ target.path }}</code>
          <small v-if="target.zone === 'sensitive'" class="is-sensitive">
            {{ t('desktop.approval.paths.zoneSensitive') }}
          </small>
          <small v-else-if="target.zone === 'outside'">
            {{ t('desktop.approval.paths.zoneOutside') }}
          </small>
        </li>
      </ul>
      <p v-if="grantNotice" class="desktop-approval-card__grant">
        {{ grantNotice }}
      </p>
    </div>
    <section
      v-else-if="review?.card === 'arguments'"
      class="desktop-approval-card__details"
    >
      <NDescriptions v-bind="detailsProps">
        <template v-if="review.parameters?.length">
          <NDescriptionsItem v-for="parameter in review.parameters" :key="parameter.name">
            <template #label>
              <code>{{ parameter.name }}</code>
            </template>
            <span class="flex text-muted text-[length:var(--buddy-chat-caption-font-size)] leading-[var(--buddy-chat-caption-line-height)] [overflow-wrap:anywhere] whitespace-pre-wrap">{{ parameter.value }}</span>
          </NDescriptionsItem>
        </template>
        <NDescriptionsItem v-else :label="t('desktop.approval.argumentNames')">
          {{ review.argumentNames.join(', ') || t('desktop.approval.noArguments') }}
        </NDescriptionsItem>
      </NDescriptions>
    </section>
    <p v-else class="border border-solid border-border rounded-2 bg-subtle py-[0.65rem] px-[0.7rem]">
      {{ t('desktop.approval.unsupported') }}
    </p>
    <footer class="flex items-center justify-end gap-[0.6rem]">
      <div class="flex items-center justify-end gap-2">
        <NButton
          size="small"
          type="error"
          :disabled="isResolving"
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
            :disabled="isResolving"
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
            :disabled="isResolving"
            :options="reuseOptions"
            :render-label="renderScopeLabel"
            @select="approveForScope"
          >
            <NButton
              class="desktop-approval-card__scope-button"
              size="small"
              type="primary"
              :disabled="isResolving"
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

.desktop-approval-card ul,
.desktop-approval-card p {
  margin: 0;
}

.desktop-approval-card ul {
  padding-left: 1.8rem;
}

.desktop-approval-card code {
  color: var(--buddy-chat-code-color);
  font-family: var(--buddy-font-mono);
  font-size: var(--buddy-chat-code-font-size);
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
