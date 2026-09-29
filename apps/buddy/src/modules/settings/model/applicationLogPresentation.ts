import type { ApplicationLogRecord } from '@buddy-shared/diagnostics/applicationLog'
import type { BuddyI18nKey, BuddyLocale, BuddyTranslate } from '@/i18n/buddyI18n'

const eventTitles: Record<string, BuddyI18nKey> = {
  'performance.sample': 'applicationLogs.performance.sample',
  'performance.cpu_profile': 'applicationLogs.performance.profile',
  'performance.sustained_cpu': 'applicationLogs.performance.sustained',
  'app.starting': 'applicationLogs.event.appStarting',
  'app.ready': 'applicationLogs.event.appReady',
  'app.stopping': 'applicationLogs.event.appStopping',
  'app.stopped': 'applicationLogs.event.appStopped',
  'app.degraded': 'applicationLogs.event.degraded',
  'app.recovered': 'applicationLogs.event.recovered',
  'component.registered': 'applicationLogs.event.registered',
  'component.ready': 'applicationLogs.event.serviceReady',
  'startup.step.started': 'applicationLogs.event.initializing',
  'startup.step.completed': 'applicationLogs.event.initialized',
  'recorder.loss': 'applicationLogs.event.loss',
  'process.stderr': 'applicationLogs.event.processOutput',
}

const actionTitles: Record<string, BuddyI18nKey> = {
  started: 'applicationLogs.event.started',
  starting: 'applicationLogs.event.starting',
  stopping: 'applicationLogs.event.stopping',
  stopped: 'applicationLogs.event.stopped',
  ready: 'applicationLogs.event.ready',
  completed: 'applicationLogs.event.completed',
  failed: 'applicationLogs.event.failed',
  cancelled: 'applicationLogs.event.cancelled',
  interrupted: 'applicationLogs.event.interrupted',
  requested: 'applicationLogs.event.requested',
  authorized: 'applicationLogs.event.authorized',
  denied: 'applicationLogs.event.denied',
}

export function applicationLogTitle(record: ApplicationLogRecord, t: BuddyTranslate): string {
  const key = eventTitles[record.event] ?? actionTitles[record.event.split(/[._]/).at(-1)!]
  return key ? t(key) : record.event
}

export function formatLogTime(timestamp: string, language: BuddyLocale, full = false): string {
  return new Intl.DateTimeFormat(language, {
    ...(full ? { month: '2-digit', day: '2-digit' } as const : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    ...(full ? {} : { fractionalSecondDigits: 3 as const }),
  }).format(new Date(timestamp))
}

export function formatLogDuration(duration: number | undefined): string {
  if (duration === undefined)
    return '—'
  return duration < 1000 ? `${Math.round(duration)} ms` : `${(duration / 1000).toFixed(2)} s`
}
