import type {
  AgentChatAttachmentContent,
  AgentChatContextMessage,
  ChatSkillInvocation,
} from '@haohaoxue/lexora-contracts'
import type { BaseMessage, MessageContent } from '@langchain/core/messages'
import { Buffer } from 'node:buffer'
import { AGENT_TRANSLATOR_SKILL_KEY, CHAT_MESSAGE_ATTACHMENT_TYPE } from '@haohaoxue/lexora-contracts'
import { isTextLikeFile } from '@haohaoxue/lexora-shared/file'
import { AIMessage, HumanMessage } from '@langchain/core/messages'

export interface ToLangChainChatMessagesOptions {
  triggerUserMessageId?: string | null
  inputAttachments?: AgentChatAttachmentContent[]
}

const MAX_TEXT_FILE_CONTENT_CHARS = 120_000

export function toLangChainChatMessages(
  messages: AgentChatContextMessage[],
  options: ToLangChainChatMessagesOptions = {},
): BaseMessage[] {
  return messages.map(message => toLangChainChatMessage(message, {
    inputAttachments: message.id === options.triggerUserMessageId ? options.inputAttachments : undefined,
  }))
}

export function toLangChainChatMessage(
  message: AgentChatContextMessage,
  options: {
    inputAttachments?: AgentChatAttachmentContent[]
  } = {},
): BaseMessage {
  if (message.role === 'assistant') {
    return new AIMessage({
      id: message.id,
      content: message.content,
    })
  }

  return new HumanMessage({
    id: message.id,
    content: formatHumanMessageContent(message, options.inputAttachments ?? []),
  })
}

function formatHumanMessageContent(
  message: AgentChatContextMessage,
  attachments: AgentChatAttachmentContent[],
): string | MessageContent {
  const skillInvocation = formatSkillInvocation(message.skillInvocation)
  const text = skillInvocation ? `${skillInvocation}\n\n${message.content}` : message.content

  if (attachments.length === 0) {
    return text
  }

  return [
    {
      type: 'text',
      text,
    },
    ...attachments.map(formatAttachmentContentBlock),
  ] as MessageContent
}

function formatAttachmentContentBlock(attachment: AgentChatAttachmentContent): Record<string, unknown> {
  if (attachment.type === CHAT_MESSAGE_ATTACHMENT_TYPE.IMAGE) {
    return {
      type: 'image_url',
      image_url: {
        url: `data:${attachment.mimeType};base64,${attachment.contentBase64}`,
      },
    }
  }

  if (isTextLikeFile(attachment)) {
    return {
      type: 'text',
      text: formatTextFileAttachment(attachment),
    }
  }

  return {
    type: 'file',
    data: attachment.contentBase64,
    mimeType: attachment.mimeType,
    metadata: {
      filename: attachment.fileName,
    },
  }
}

function formatTextFileAttachment(attachment: AgentChatAttachmentContent): string {
  const content = Buffer.from(attachment.contentBase64, 'base64').toString('utf8')
  const trimmedContent = content.length > MAX_TEXT_FILE_CONTENT_CHARS
    ? `${content.slice(0, MAX_TEXT_FILE_CONTENT_CHARS)}\n[Lexora: 文件内容已截断]`
    : content

  return [
    `[Lexora 文件: ${attachment.fileName}]`,
    `mimeType: ${attachment.mimeType}`,
    `size: ${attachment.size}`,
    '',
    trimmedContent,
    `[Lexora 文件结束: ${attachment.fileName}]`,
  ].join('\n')
}

function formatSkillInvocation(skillInvocation: ChatSkillInvocation | null | undefined): string {
  if (!skillInvocation) {
    return ''
  }

  if (skillInvocation.skillKey === AGENT_TRANSLATOR_SKILL_KEY) {
    return [
      '[Lexora 技能选择]',
      `skillKey: ${skillInvocation.skillKey}`,
      'sourceLanguage: auto',
      `targetLanguage: ${skillInvocation.targetLanguage.name}`,
      skillInvocation.targetLanguage.tag ? `targetLanguageTag: ${skillInvocation.targetLanguage.tag}` : '',
      'instruction: 用户已在对话输入区选择翻译目标语言；本轮优先使用 translator skill，将用户正文翻译为目标语言。',
      '[Lexora 技能选择结束]',
    ].filter(Boolean).join('\n')
  }

  return ''
}
