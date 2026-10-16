import type { CryptoConfig } from '../../config/auth.config'
import type { WeixinCredential, WeixinRuntimeAccount } from './bots.interface'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { decryptAes256Gcm, encryptAes256Gcm } from '../../utils/crypto'

@Injectable()
export class BotCredentialsService {
  private readonly encryptionKey: string

  constructor(configService: ConfigService) {
    this.encryptionKey = configService.getOrThrow<CryptoConfig>('crypto').encryptionKey
  }

  encryptWeixinCredential(credential: WeixinCredential): string {
    return encryptAes256Gcm(JSON.stringify(credential), this.encryptionKey)
  }

  decryptWeixinCredential(input: {
    id: string
    userId: string
    credentialEncrypted: string
    getUpdatesCursor: string
  }): WeixinRuntimeAccount {
    const credential = JSON.parse(decryptAes256Gcm(input.credentialEncrypted, this.encryptionKey)) as WeixinCredential

    return {
      ...credential,
      id: input.id,
      ownerUserId: input.userId,
      getUpdatesCursor: input.getUpdatesCursor,
    }
  }
}
