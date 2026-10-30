import { z } from 'zod'

export const credentialVaultSystemCodeSchema = z.enum([
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EEXIST',
  'ENOSPC',
  'EDQUOT',
  'EROFS',
  'EIO',
  'EMFILE',
  'ENFILE',
  'EINVAL',
  'ENAMETOOLONG',
  'ELOOP',
  'EBUSY',
  'EXDEV',
])

export const credentialVaultFailureSchema = z.object({
  kind: z.literal('credential_vault'),
  operation: z.enum(['read', 'write', 'delete', 'list']),
  namespace: z.enum(['providers', 'connectors', 'web', 'sync', 'backup', 'images']),
  phase: z.enum(['availability', 'list_directory', 'read_file', 'decrypt', 'parse', 'validate', 'prepare_directory', 'serialize', 'encrypt', 'write_file', 'delete_file', 'unknown']),
  reason: z.enum(['operation_failed', 'unavailable', 'invalid_envelope', 'unsupported_version', 'identifier_mismatch', 'invalid_credential_type']),
  systemCode: credentialVaultSystemCodeSchema.optional(),
}).strict()

export type CredentialVaultFailure = z.infer<typeof credentialVaultFailureSchema>
