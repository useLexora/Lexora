<script setup lang="ts">
import type { BuddyToolPresentation } from '@buddy-shared/runs/runEventPresentation'
import type { ToolFailureCode } from '@buddy-shared/runs/toolFailure'
import type { ChatAgentToolNode } from '../../model/transcript/chatStreamingMessage'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import BuddyChatImageToolDetails from './BuddyChatImageToolDetails.vue'
import BuddyChatToolDiff from './BuddyChatToolDiff.vue'
import BuddyChatToolRead from './BuddyChatToolRead.vue'
import BuddyChatToolSearch from './BuddyChatToolSearch.vue'
import BuddyChatToolToolbar from './BuddyChatToolToolbar.vue'
import { useChatContent } from './chatContentContext'
import DesktopTerminalTranscript from './DesktopTerminalTranscript.vue'

const props = defineProps<{
  errorCode?: ToolFailureCode
  language: BuddyLocale
  presentation: BuddyToolPresentation
  status: ChatAgentToolNode['status']
  toolName: string
}>()

const { t } = useBuddyI18n(() => props.language)
const actions = useChatContent()
const filePath = computed(() => props.status !== 'denied' && !props.errorCode && (props.presentation.card === 'read' || props.presentation.card === 'diff')
  ? props.presentation.path
  : undefined)
const canPreview = computed(() => filePath.value !== undefined && actions.canPreviewFile(filePath.value))
const diff = computed(() => props.status !== 'denied' && props.presentation.card === 'diff' ? props.presentation.diff : null)
const terminal = computed(() => props.presentation.card === 'terminal' ? props.presentation : null)
const image = computed(() => props.presentation.card === 'image'
  ? props.presentation
  : null)
const directoryAuthorization = computed(() => (
  props.presentation.card === 'directory-authorization'
    ? props.presentation
    : null
))
const directoryRelation = computed(() => {
  switch (directoryAuthorization.value?.relation) {
    case 'exact': return t('desktop.chat.processToolDirectoryRelationExact')
    case 'ancestor': return t('desktop.chat.processToolDirectoryRelationBroader')
    case 'descendant': return t('desktop.chat.processToolDirectoryRelationNarrower')
    case 'unrelated': return t('desktop.chat.processToolDirectoryRelationUnrelated')
    default: return null
  }
})
const terminalShell = computed(() => props.toolName === 'powershell' ? 'powershell' : 'bash')
const terminalOutput = computed(() => props.status === 'denied'
  ? null
  : terminal.value?.output ?? null)
const terminalNotice = computed(() => {
  if (!terminal.value || terminal.value.output)
    return null
  if (props.status === 'completed')
    return t('desktop.chat.processToolNoOutput')
  if (props.status === 'interrupted')
    return t('desktop.chat.processToolIncompleteOutput')
  return null
})
const output = computed(() => {
  const p = props.presentation
  return props.status !== 'denied' && p.card !== 'terminal' && 'output' in p && p.output !== null
    ? { content: p.output, truncated: p.truncated }
    : null
})
</script>

<template>
  <div class="buddy-chat-tool-details" :class="`is-${status}`">
    <BuddyChatImageToolDetails
      v-if="image"
      :language="language"
      :presentation="image"
    />
    <section
      v-if="directoryAuthorization"
      class="buddy-chat-tool-details__section buddy-chat-directory-authorization"
    >
      <dl>
        <div v-if="directoryAuthorization.requestedRoot">
          <dt>{{ t('desktop.chat.processToolDirectoryRequestedRoot') }}</dt>
          <dd><code>{{ directoryAuthorization.requestedRoot }}</code></dd>
        </div>
        <div v-if="directoryAuthorization.selectedRoot">
          <dt>{{ t('desktop.chat.processToolDirectorySelectedRoot') }}</dt>
          <dd><code>{{ directoryAuthorization.selectedRoot }}</code></dd>
        </div>
        <div v-if="directoryRelation">
          <dt>{{ t('desktop.chat.processToolDirectoryScopeRelation') }}</dt>
          <dd>{{ directoryRelation }}</dd>
        </div>
        <div v-if="directoryAuthorization.requestSatisfied !== null">
          <dt>{{ t('desktop.chat.processToolDirectoryRequestSatisfied') }}</dt>
          <dd>
            {{ t(directoryAuthorization.requestSatisfied
              ? 'desktop.approval.directory.satisfied'
              : 'desktop.approval.directory.unsatisfied') }}
          </dd>
        </div>
        <div v-if="directoryAuthorization.coveredDirectoryCount > 0">
          <dt>{{ t('desktop.chat.processToolDirectoryExpanded') }}</dt>
          <dd>
            {{ t('desktop.chat.processToolDirectoryCoveredCount', {
              count: directoryAuthorization.coveredDirectoryCount,
            }) }}
          </dd>
        </div>
      </dl>
    </section>
    <section v-if="terminal" class="buddy-chat-terminal-card">
      <BuddyChatToolToolbar
        :language="language" :title="t('desktop.chat.processToolCommand')"
        :copy-text="terminal.command" :copy-label="t('desktop.chat.processToolCopyCommand')"
      />
      <DesktopTerminalTranscript
        :command="terminal.command"
        :output="terminalOutput"
        :shell="terminalShell"
      />
      <p v-if="terminalNotice" class="buddy-chat-terminal-card__notice">
        {{ terminalNotice }}
      </p>
      <small v-if="terminal.truncated" class="buddy-chat-terminal-card__truncated">
        {{ t('desktop.chat.processToolTruncated') }}
      </small>
    </section>
    <BuddyChatToolDiff v-if="diff" :diff="diff" :language="language" :file-path="filePath" />
    <section
      v-if="output || (canPreview && !diff)"
      class="buddy-chat-tool-details__section is-output"
    >
      <BuddyChatToolToolbar
        :language="language" :title="!diff && filePath ? filePath : t('desktop.chat.processToolOutput')"
        :copy-text="output?.content" :file-path="diff ? undefined : filePath"
      >
        <small v-if="output?.truncated" class="buddy-chat-tool-details__truncated">{{ t('desktop.chat.processToolTruncated') }}</small>
      </BuddyChatToolToolbar>
      <template v-if="output">
        <BuddyChatToolRead
          v-if="presentation.card === 'read' && status !== 'failed' && status !== 'interrupted'"
          :output="output.content" :line-start="presentation.lineStart" :native="toolName === 'read'"
        />
        <BuddyChatToolSearch
          v-else-if="presentation.card === 'search' && status !== 'failed' && status !== 'interrupted'"
          :output="output.content" :tool-name="toolName" :language="language"
        />
        <pre v-else><code>{{ output.content }}</code></pre>
      </template>
    </section>
  </div>
</template>

<style scoped lang="scss">
.buddy-chat-tool-details {
  display: grid;
  gap: var(--buddy-chat-gap-block);
  min-width: 0;
  margin: 4px 0 8px;
  margin-inline-start: var(--buddy-chat-activity-indent);
}

.buddy-chat-terminal-card {
  min-width: 0;
  overflow: hidden;
  border-radius: var(--buddy-radius-micro);
  background: var(--buddy-surface-subtle);
}

.buddy-chat-terminal-card__notice {
  margin: 0;
  color: var(--buddy-text-muted);
  font-size: var(--buddy-chat-caption-font-size);
  line-height: var(--buddy-chat-code-line-height);
  padding: 0.45rem 0.625rem 0.55rem;
}

.buddy-chat-terminal-card__truncated {
  display: block;
  color: var(--buddy-text-muted);
  padding: 0 0.75rem 0.65rem;
}

.buddy-chat-tool-details__section {
  min-width: 0;
  overflow: hidden;
  border: 0;
  border-radius: var(--buddy-radius-micro);
  background: var(--buddy-surface-raised);

  &.is-output {
    background: var(--buddy-surface-subtle);
  }

}

.buddy-chat-tool-details__truncated {
  flex: none;
  font-size: inherit;
}

.buddy-chat-directory-authorization {
  padding: 0.65rem 0.7rem;

  dl {
    display: grid;
    gap: 0.45rem;
    margin: 0;
  }

  dl > div {
    display: grid;
    grid-template-columns: minmax(6rem, 0.3fr) minmax(0, 1fr);
    gap: 0.6rem;
  }

  dt,
  dd {
    margin: 0;
    font-size: var(--buddy-chat-caption-font-size);
    line-height: var(--buddy-chat-caption-line-height);
  }

  dt {
    color: var(--buddy-text-secondary);
  }

  dd {
    min-width: 0;
    color: var(--buddy-text-primary);
    overflow-wrap: anywhere;
  }

  code {
    color: var(--buddy-chat-code-color);
    font-family: var(--buddy-font-mono);
    font-size: var(--buddy-chat-code-font-size);
  }
}

.buddy-chat-tool-details__section pre {
  max-height: 15rem;
  margin: 0;
  overflow: auto;
  color: var(--buddy-chat-code-color);
  font-family: var(--buddy-font-mono);
  font-size: var(--buddy-chat-code-font-size);
  line-height: var(--buddy-chat-code-line-height);
  padding: 0.625rem 0.75rem;
  tab-size: 2;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
