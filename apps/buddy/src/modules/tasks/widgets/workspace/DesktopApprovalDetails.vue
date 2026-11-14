<script setup lang="ts">
import type { ApprovalReviewPayload } from '@buddy-shared/permissions/approvalReviewPayload'
import type { BuddyExecutionProfile } from '@buddy-shared/permissions/executionProfile'
import type { CSSProperties } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NDescriptions, NDescriptionsItem } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { translateSystemInterruption } from '../../model/approvals/systemActionPresentation'

const props = defineProps<{
  review: ApprovalReviewPayload | null
  language: BuddyLocale
  browserEffect: string
  systemEffect: string
}>()
const { t } = useBuddyI18n(() => props.language)
const review = computed(() => props.review)
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
const executionProfileKeys: Record<BuddyExecutionProfile, 'desktop.chat.permissionModePolicy' | 'desktop.chat.executionProfileFull' | 'desktop.chat.executionProfileReadOnly'> = {
  full_access: 'desktop.chat.executionProfileFull',
  read_only: 'desktop.chat.executionProfileReadOnly',
  workspace_write: 'desktop.chat.permissionModePolicy',
}
const shellReason = computed(() => (
  review.value?.card === 'shell' && review.value.context
    ? t(`desktop.approval.shell.reason.${review.value.context.reason}`)
    : ''
))
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
  if (review.value.action === 'press')
    return t('desktop.approval.browser.action.pressKey', { key: review.value.key ?? '' })
  return t(`desktop.approval.browser.action.${review.value.action}`)
})
</script>

<template>
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
  <section v-else-if="review?.card === 'network-permission'" class="desktop-approval-card__details">
    <NDescriptions v-bind="detailsProps">
      <NDescriptionsItem :label="t('desktop.approval.target')">
        <code>{{ review.host }}<template v-if="review.port"> · {{ review.port }}</template></code>
      </NDescriptionsItem>
      <NDescriptionsItem :label="t('desktop.approval.effect')">
        {{ t(`desktop.approval.network.${review.operation}`) }}
      </NDescriptionsItem>
      <NDescriptionsItem v-if="review.command" :label="t('desktop.approval.runCommand')">
        <pre>{{ review.command }}</pre>
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
  <div v-else-if="review?.card === 'paths'" class="desktop-approval-card__review border border-solid border-border rounded-2 bg-subtle py-[0.65rem] px-[0.7rem]">
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
  <p v-else class="desktop-approval-card__review border border-solid border-border rounded-2 bg-subtle py-[0.65rem] px-[0.7rem]">
    {{ t('desktop.approval.unsupported') }}
  </p>
</template>

<style scoped lang="scss">
.desktop-approval-card__details,
.desktop-approval-card__review {
  margin: 0;
  max-height: min(24rem, 40vh);
  overflow-y: auto;
}

.desktop-approval-card__details pre {
  max-height: 9rem;
  margin: 0;
  overflow: auto;
  color: var(--buddy-chat-code-color);
  font-family: var(--buddy-font-mono);
  font-size: var(--buddy-chat-code-font-size);
  line-height: var(--buddy-chat-code-line-height);
  white-space: pre-wrap;
}

.desktop-approval-card__review ul,
.desktop-approval-card__review p {
  margin: 0;
}

.desktop-approval-card__review ul {
  padding-left: 1.8rem;
}

.desktop-approval-card__details code,
.desktop-approval-card__review code {
  color: var(--buddy-chat-code-color);
  font-family: var(--buddy-font-mono);
  font-size: var(--buddy-chat-code-font-size);
}
</style>
