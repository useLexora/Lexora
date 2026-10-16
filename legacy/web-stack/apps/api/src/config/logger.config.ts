import process from 'node:process'
import { registerAs } from '@nestjs/config'

export const loggerConfig = registerAs('logger', () => {
  const isProduction = process.env.NODE_ENV === 'production'

  return {
    level: isProduction ? 'info' : 'debug',
    pretty: !isProduction,
  }
})
