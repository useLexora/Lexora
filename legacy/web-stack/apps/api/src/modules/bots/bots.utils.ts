import type { ChatMessageContentJSON } from '@haohaoxue/lexora-contracts'
import type { WeixinMessage, WeixinMessageItem } from './bots.interface'
import { WeixinMessageItemType, WeixinMessageType } from './bots.interface'

function textFromItem(item: WeixinMessageItem): string {
  if (item.type === WeixinMessageItemType.TEXT && item.text_item?.text != null) {
    const text = String(item.text_item.text)
    const ref = item.ref_msg

    if (!ref) {
      return text
    }

    const refParts = [
      ref.title,
      ref.message_item ? textFromItem(ref.message_item) : undefined,
    ].filter((part): part is string => Boolean(part))

    if (refParts.length === 0) {
      return text
    }

    return `[引用: ${refParts.join(' | ')}]\n${text}`
  }

  if (item.type === WeixinMessageItemType.VOICE && item.voice_item?.text) {
    return item.voice_item.text
  }

  return ''
}

function mediaFingerprintFromItem(item: WeixinMessageItem): string {
  if (item.type === WeixinMessageItemType.IMAGE) {
    return item.image_item?.media?.encrypt_query_param
      ?? item.image_item?.media?.full_url
      ?? item.image_item?.url
      ?? ''
  }

  return ''
}

function itemHasSupportedContent(item: WeixinMessageItem): boolean {
  return Boolean(textFromItem(item).trim() || mediaFingerprintFromItem(item))
}

export function extractWeixinMessageText(message: WeixinMessage): string {
  for (const item of message.item_list ?? []) {
    const text = textFromItem(item).trim()

    if (text) {
      return text
    }
  }

  return ''
}

export function hasWeixinMessageContent(message: WeixinMessage): boolean {
  return Boolean(message.item_list?.some(itemHasSupportedContent))
}

export function shouldHandleWeixinMessage(message: WeixinMessage): boolean {
  if (message.message_type === WeixinMessageType.BOT) {
    return false
  }

  return Boolean(message.from_user_id && hasWeixinMessageContent(message))
}

export function createWeixinMessageKey(message: WeixinMessage): string {
  if (message.message_id != null) {
    return `message_id:${message.message_id}`
  }

  if (message.seq != null) {
    return `seq:${message.seq}`
  }

  return [
    message.from_user_id ?? 'unknown',
    message.create_time_ms ?? 'unknown',
    extractWeixinMessageText(message)
    || message.item_list?.map(mediaFingerprintFromItem).find(Boolean)
    || 'empty',
  ].join(':')
}

export function toPlainTextContentJSON(content: string): ChatMessageContentJSON {
  return {
    type: 'doc',
    content: content.split('\n').map((line) => {
      if (!line) {
        return { type: 'paragraph' }
      }

      return {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: line,
          },
        ],
      }
    }),
  }
}

export function formatWeixinPeerTitle(peerId: string): string {
  const normalized = peerId.replace(/@im\.wechat$/i, '').trim()
  const suffix = normalized ? normalized.slice(-6) : peerId.slice(-6)
  return `微信 · ${suffix || '新联系人'}`
}
