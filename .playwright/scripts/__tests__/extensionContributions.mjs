import fs from 'node:fs/promises'
import path from 'node:path'

export async function writeContributionPlugin(directory, name, { uno = false } = {}) {
  const id = `tests.${name}`
  const manifest = {
    schemaVersion: 1,
    format: uno ? 'source' : 'compiled',
    ...(uno ? { styles: { uno: true } } : {}),
    id,
    name: `Contribution ${name}`,
    version: '1.0.0',
    apiVersion: 3,
    engines: { lexora: '*' },
    entry: 'host.js',
    permissions: { themeManagement: uno },
    contributes: {
      commands: ['read', 'save', 'theme'].map(command => ({ id: `${id}.${command}`, title: command, hidden: true })),
      views: [
        { id: `${id}.settings`, title: `Settings ${name}`, entry: 'settings.js', resource: 'none', location: 'page' },
        { id: `${id}.footer`, title: `Footer ${name}`, entry: 'footer.js', resource: 'none' },
        { id: `${id}.actions`, title: `Actions ${name}`, entry: 'actions.js', resource: 'none' },
      ],
      navigation: { title: `Settings ${name}`, view: `${id}.settings` },
      placements: [
        { id: `${id}.footer-slot`, view: `${id}.footer`, kind: 'slot', target: 'composer.footer', enabled: false, height: 28, when: { 'page.id': 'lexora.tasks' } },
        { id: `${id}.actions-slot`, view: `${id}.actions`, kind: 'slot', target: 'composer.accessory', height: 40, when: { 'page.id': 'lexora.tasks' } },
      ],
    },
  }
  const files = {
    'extension.json': JSON.stringify(manifest),
    'host.js': `export const activate = ${activate.toString()}`,
    'settings.js': `export const render = (...args) => (${settings.toString()})(${JSON.stringify(id)}, ...args)`,
    'footer.js': `export const render = (...args) => (${footer.toString()})(${JSON.stringify(id)}, ${uno}, ...args)`,
    'actions.js': `export const render = (...args) => (${actions.toString()})(${JSON.stringify(id)}, ...args)`,
  }
  await fs.mkdir(directory, { recursive: true })
  await Promise.all(Object.entries(files).map(([file, content]) => fs.writeFile(path.join(directory, file), content)))
  return id
}

async function activate(context) {
  const id = context.extension.id
  let state = { enabled: false, active: true, ...await context.storage.get() }
  const apply = async () => {
    await context.placements[state.enabled ? 'show' : 'hide'](`${id}.footer-slot`)
    await context.views.broadcast(state)
  }
  context.subscriptions.add(context.commands.register(`${id}.read`, () => state))
  context.subscriptions.add(context.commands.register(`${id}.theme`, async () => {
    const document = { schemaVersion: 1, colors: { accent: '#207cba' } }
    const resolved = await context.themes.resolve('light', document)
    const saved = await context.themes.save({ schemaVersion: 1, label: 'Host SDK theme', appearance: 'light', document })
    return { accent: resolved.colors.accent, id: saved.id }
  }))
  context.subscriptions.add(context.commands.register(`${id}.save`, async ({ arguments: patch }) => {
    state = { ...state, ...patch }
    await context.storage.set(state)
    await apply()
    return state
  }))
  await apply()
}

async function settings(pluginId, context, container) {
  container.dataset.contributionFixture = `${pluginId}.settings`
  container.innerHTML = '<h1>Plugin preferences</h1><label><input type="checkbox"> Enable footer</label><p role="status"></p>'
  const checkbox = container.querySelector('input')
  checkbox.checked = (await context.commands.execute(`${pluginId}.read`)).enabled
  checkbox.onchange = async () => {
    await context.commands.execute(`${pluginId}.save`, { enabled: checkbox.checked })
    container.querySelector('[role=status]').textContent = checkbox.checked ? 'Enabled' : 'Disabled'
  }
}

async function footer(pluginId, uno, context, container) {
  container.dataset.contributionFixture = `${pluginId}.footer`
  window.fixture = { instance: crypto.randomUUID(), visible: context.visible }
  context.onVisibilityChange(visible => window.fixture.visible = visible)
  if (uno)
    container.className = 'h-full grid place-items-center bg-accent text-on-accent text-[14px] font-sans'
  else
    container.style.cssText = 'height:100%;display:grid;place-items:center;color:var(--lexora-text);font:14px system-ui'
  container.textContent = `${pluginId} content`
  const apply = state => context.setActive(state.active)
  context.onMessage(state => void apply(state))
  await apply(await context.commands.execute(`${pluginId}.read`))
  if (uno) {
    const document = { schemaVersion: 1, colors: { accent: '#96304d' } }
    const resolved = await context.themes.resolve('light', document)
    const saved = await context.themes.save({ schemaVersion: 1, label: 'View SDK theme', appearance: 'light', document })
    window.fixture.theme = { view: { accent: resolved.colors.accent, id: saved.id }, host: await context.commands.execute(`${pluginId}.theme`) }
  }
}

async function actions(pluginId, context, container) {
  container.dataset.contributionFixture = `${pluginId}.actions`
  container.style.cssText = 'display:flex;align-items:center;height:100%;font:14px system-ui;color:var(--lexora-text)'
  const label = document.createElement('label')
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = (await context.commands.execute(`${pluginId}.read`)).active
  label.append(checkbox, ` Content ${pluginId}`)
  container.append(label)
  context.onMessage(state => checkbox.checked = state.active)
  checkbox.onchange = async () => {
    await context.commands.execute(`${pluginId}.save`, { active: checkbox.checked })
  }
}
