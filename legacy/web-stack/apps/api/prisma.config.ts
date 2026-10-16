import process from 'node:process'
import { defineConfig } from 'prisma/config'
import 'dotenv/config'

export default defineConfig({
  schema: 'prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
})
