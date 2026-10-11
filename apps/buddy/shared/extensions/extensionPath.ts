import { z } from 'zod'

export const extensionPathSchema = z.string().min(1).max(256).refine((value) => {
  const parts = value.split('/')
  return /^[\w./-]+$/.test(value) && !value.startsWith('__') && parts.every(part => part && part !== '.' && part !== '..' && !part.endsWith('.') && !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part))
}, 'Invalid package path')
