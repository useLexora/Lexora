import { z } from 'zod'

export const DEFAULT_LOCAL_BACKUP_LIMIT = 3
export const localBackupLimitSchema = z.number().int().min(1).max(10)
