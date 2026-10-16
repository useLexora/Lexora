import type { ToolCall } from '@langchain/core/messages'

export type BaseToolCall = ToolCall

export function getToolCallId(toolCall: BaseToolCall): string {
  return toolCall.id ?? `${toolCall.name}:missing-id`
}

export function stringifyToolPayload(value: unknown): string {
  try {
    const text = typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2)

    return redactSensitivePayloadText(text)
  }
  catch {
    return redactSensitivePayloadText(String(value))
  }
}

export function formatToolExecutionError(error: unknown): string {
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'Tool execution failed.'

  return redactSensitiveQueryParams(message)
}

function redactSensitiveQueryParams(message: string): string {
  return message.replace(
    /([?&](?:key|api_key|apiKey|token|access_token|authorization)=)[^&\s"'<>]+/gi,
    '$1[redacted]',
  )
}

function redactSensitivePayloadText(text: string): string {
  return redactSensitiveQueryParams(text).replace(
    /("(?:apiKey|api_key|key|token|accessToken|access_token|authorization|secret|password)"\s*:\s*)"[^"]*"/gi,
    '$1"[redacted]"',
  )
}
