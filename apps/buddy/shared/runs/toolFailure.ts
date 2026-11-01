export type ToolFailureCode = 'INVALID_PATH' | 'PATH_NOT_FOUND' | 'VALIDATION_FAILED' | 'SHELL_RESOURCE_TIMEOUT' | 'SHELL_COMMAND_TIMEOUT'

export function isToolFailureCode(value: unknown): value is ToolFailureCode {
  return value === 'INVALID_PATH' || value === 'PATH_NOT_FOUND' || value === 'VALIDATION_FAILED' || value === 'SHELL_RESOURCE_TIMEOUT' || value === 'SHELL_COMMAND_TIMEOUT'
}
