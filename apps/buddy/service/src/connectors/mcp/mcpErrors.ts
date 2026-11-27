import type { ConnectorErrorCode } from '../../../../shared/connectors/connectorState'
import { AuthorizationServerMismatchError, IssuerMismatchError, SdkError, SdkErrorCode, SdkHttpError, UnauthorizedError } from '@modelcontextprotocol/client'

export class McpClientError extends Error {
  readonly code: ConnectorErrorCode

  constructor(code: ConnectorErrorCode, options?: ErrorOptions) {
    super('MCP operation failed', options)
    this.name = 'McpClientError'
    this.code = code
  }
}

function isExpiredHttpSession(error: SdkHttpError): boolean {
  if (error.status === 404)
    return true
  if (error.status !== 400 || typeof error.data.text !== 'string')
    return false
  try {
    const response = JSON.parse(error.data.text)
    return response?.jsonrpc === '2.0' && response.error?.code === -32000
      && (response.error.message === 'Bad Request: Server not initialized' || response.error.message === 'Server not initialized')
  }
  catch { return false }
}

export function mcpErrorCode(error: unknown, fallback: ConnectorErrorCode = 'MCP_SERVER_UNAVAILABLE', hasHttpSession = false): ConnectorErrorCode {
  if (error instanceof McpClientError)
    return error.code
  if (error instanceof AuthorizationServerMismatchError || error instanceof IssuerMismatchError)
    return 'MCP_AUTHENTICATION_FAILED'
  if (error instanceof UnauthorizedError)
    return 'MCP_AUTHENTICATION_REQUIRED'
  if (error instanceof SdkHttpError) {
    if (hasHttpSession && isExpiredHttpSession(error))
      return 'MCP_SESSION_EXPIRED'
    if (error.status === 401)
      return 'MCP_AUTHENTICATION_REQUIRED'
    if (error.status === 403)
      return 'MCP_ACCESS_DENIED'
    if (error.status >= 500 && error.status < 600)
      return 'MCP_SERVER_UNAVAILABLE'
  }
  if ((error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) || (error instanceof Error && error.name === 'TimeoutError'))
    return 'MCP_REQUEST_TIMEOUT'
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
    return 'MCP_COMMAND_NOT_FOUND'
  return fallback
}
