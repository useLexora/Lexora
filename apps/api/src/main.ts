import process from 'node:process'
import { createApp } from './app.ts'
import { readConfig } from './config.ts'
import { createDatabase } from './database.ts'

const config = readConfig()
const db = createDatabase(config.DATABASE_URL)
const app = createApp(db, config, { logger: true })
const cleanup = setInterval(() => {
  Promise.all([
    db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
    db.oAuthFlow.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
  ]).catch(() => app.log.error('Session cleanup failed'))
}, 60 * 60 * 1000)
cleanup.unref()
app.addHook('onClose', async () => {
  clearInterval(cleanup)
  await db.$disconnect()
})
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.close().catch(() => {
      process.exitCode = 1
    })
  })
}
app.listen({ port: config.PORT, host: '0.0.0.0' }).catch(async (error: unknown) => {
  app.log.error({ errorType: error instanceof Error ? error.name : 'Unknown' }, 'Community API failed to start')
  await app.close()
  process.exitCode = 1
})
