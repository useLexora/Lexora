import app from './app'
import applicationLogs from './applicationLogs'
import approvals from './approvals'
import automations from './automations'
import chat from './chat'
import diagnostics from './diagnostics'
import discovery from './discovery'
import images from './images'
import mcp from './mcp'
import models from './models'
import onboarding from './onboarding'
import pet from './pet'
import questions from './questions'
import settings from './settings'
import skills from './skills'
import speech from './speech'
import tasks from './tasks'
import usage from './usage'

export default {
  ...questions,
  ...images,
  ...app,
  ...applicationLogs,
  ...approvals,
  ...automations,
  ...chat,
  ...diagnostics,
  ...mcp,
  ...models,
  ...onboarding,
  ...discovery,
  ...pet,
  ...settings,
  ...skills,
  ...speech,
  ...tasks,
  ...usage,
}
