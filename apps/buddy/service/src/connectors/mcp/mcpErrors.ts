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

export function mcpErrorCode(error: unknown, fallback: ConnectorErrorCode = 'MCP_SERVER_UNAVAILABLE'): ConnectorErrorCode {
  if (error instanceof McpClientError)
    return error.code
  if (error instanceof AuthorizationServerMismatchError || error instanceof IssuerMismatchError)
    return 'MCP_AUTHENTICATION_FAILED'
  if (error instanceof UnauthorizedError)
    return 'MCP_AUTHENTICATION_REQUIRED'
  if (error instanceof SdkHttpError && error.status === 401)
    return 'MCP_AUTHENTICATION_REQUIRED'
  if (error instanceof SdkHttpError && error.status === 403)
    return 'MCP_ACCESS_DENIED'
  if ((error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) || (error instanceof Error && error.name === 'TimeoutError'))
    return 'MCP_REQUEST_TIMEOUT'
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
    return 'MCP_COMMAND_NOT_FOUND'
  return fallback
}
