import { BadRequestException } from '@nestjs/common'

export function normalizeEmail(email: string): string {
  const normalizedEmail = email.trim().toLowerCase()

  if (!normalizedEmail.length) {
    throw new BadRequestException('邮箱不能为空')
  }

  return normalizedEmail
}
