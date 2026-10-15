import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { ROOT } from './shared.mjs'

const pending = new Set()

export function createRunDirectory({ task, root = path.join(ROOT, '.playwright/runs'), now = new Date(), runId = randomUUID(), invocationId = randomUUID(), completeOnExit = false } = {}) {
  assert(typeof task === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(task) && task.length <= 100, 'Invalid test task name')
  assert(Number.isFinite(now.getTime()), 'Invalid run date')
  const pad = value => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  const parent = path.resolve(root, date, task)
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  let directory
  for (let attempt = 1; ; attempt++) {
    directory = path.join(parent, attempt === 1 ? time : `${time}-${pad(attempt)}`)
    try {
      fs.mkdirSync(directory, { mode: 0o700 })
      break
    }
    catch (error) {
      if (error.code !== 'EEXIST')
        throw error
    }
  }
  let revision = null
  let dirty = null
  try {
    const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    revision = git(['rev-parse', 'HEAD'])
    dirty = git(['status', '--porcelain', '--untracked-files=normal']) !== ''
  }
  catch {}
  fs.writeFileSync(path.join(directory, 'run.json'), `${JSON.stringify({
    task,
    runId,
    invocationId,
    command: [process.execPath, ...process.argv.slice(1)],
    revision,
    dirty,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcOffsetMinutes: -now.getTimezoneOffset(),
    startedAt: now.toISOString(),
    finishedAt: null,
    status: 'created',
  }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  if (completeOnExit) {
    if (!pending.size)
      process.once('exit', finishPendingRuns)
    pending.add(directory)
  }
  return directory
}

export function updateRunSummary(directory, changes) {
  const target = path.join(directory, 'run.json')
  const summary = { ...JSON.parse(fs.readFileSync(target, 'utf8')), ...changes }
  const temporary = path.join(directory, `.run-${process.pid}.json`)
  fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, target)
}

function finishPendingRuns(code) {
  for (const directory of pending)
    updateRunSummary(directory, { status: code === 0 ? 'completed' : 'failed', exitCode: code, finishedAt: new Date().toISOString() })
}
