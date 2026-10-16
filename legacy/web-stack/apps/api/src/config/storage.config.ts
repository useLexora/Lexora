import { registerAs } from '@nestjs/config'
import { getEnv } from './env.schema'

const STORAGE_REGION = 'auto'
const STORAGE_FORCE_PATH_STYLE = true

/**
 * 对象存储配置
 */
export interface StorageConfig {
  endpoint: string
  region: string
  accessKey: string
  secretKey: string
  forcePathStyle: boolean
}

export const storageConfig = registerAs('storage', (): StorageConfig => ({
  endpoint: getEnv().STORAGE_ENDPOINT,
  region: STORAGE_REGION,
  accessKey: getEnv().STORAGE_ACCESS_KEY,
  secretKey: getEnv().STORAGE_SECRET_KEY,
  forcePathStyle: STORAGE_FORCE_PATH_STYLE,
}))
