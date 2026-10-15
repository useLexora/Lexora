import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { updateRunSummary } from './run-artifacts.mjs'

export default class RunReporter {
  constructor({ directory }) {
    this.directory = directory
    this.results = []
  }

  onBegin(config, suite) {
    fs.mkdirSync(path.join(this.directory, 'logs'), { recursive: true, mode: 0o700 })
    updateRunSummary(this.directory, {
      status: 'running',
      projects: config.projects.map(project => project.name),
      tests: suite.allTests().length,
      rendererDefault: process.env.LEXORA_TEST_DEV_RENDERER === '1' ? 'development' : 'built',
      application: process.env.LEXORA_TEST_APP_PATH ?? null,
      executable: process.env.LEXORA_TEST_EXECUTABLE_PATH ?? null,
      report: 'report/index.html',
      results: 'results',
    })
  }

  onTestEnd(test, result) {
    this.results.push({ title: test.titlePath(), status: result.status, expectedStatus: test.expectedStatus, retry: result.retry })
  }

  onStdOut(chunk) { this.append('stdout.log', chunk) }
  onStdErr(chunk) { this.append('stderr.log', chunk) }

  append(name, chunk) {
    fs.appendFileSync(path.join(this.directory, 'logs', name), chunk, { mode: 0o600 })
  }

  onEnd(result) {
    updateRunSummary(this.directory, { status: result.status, finishedAt: new Date().toISOString(), durationMs: result.duration, outcomes: this.results })
  }
}
