import fs from 'node:fs/promises'
import path from 'node:path'

export async function writeContributionPlugin(directory, name, { uno = false, media = false } = {}) {
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
    ...(media ? { permissions: { network: ['https://media.example.com'], themeManagement: true } } : {}),
    contributes: {
      commands: ['read', 'save', 'failure', 'invalid', 'timeout', ...(media ? ['download'] : [])].map(command => ({ id: `${id}.${command}`, title: command, hidden: true })),
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
    'host.js': `export const activate = context => (${activate.toString()})(${media}, context)`,
    'settings.js': `export const render = (...args) => (${media ? mediaSettings.toString() : settings.toString()})(${JSON.stringify(id)}, ...args)`,
    'footer.js': `export const render = (...args) => (${footer.toString()})(${JSON.stringify(id)}, ${uno}, ...args)`,
    'actions.js': `export const render = (...args) => (${actions.toString()})(${JSON.stringify(id)}, ...args)`,
  }
  await fs.mkdir(directory, { recursive: true })
  await Promise.all(Object.entries(files).map(([file, content]) => fs.writeFile(path.join(directory, file), content)))
  return id
}

async function activate(media, context) {
  const id = context.extension.id
  if (media) {
    context.subscriptions.add(context.commands.register(`${id}.download`, async ({ arguments: { url } }) => context.network.download(url)))
  }
  let state = { enabled: false, active: true, ...await context.storage.get() }
  const apply = async () => {
    await context.placements[state.enabled ? 'show' : 'hide'](`${id}.footer-slot`)
    await context.views.broadcast(state)
  }
  context.subscriptions.add(context.commands.register(`${id}.read`, () => state))
  context.subscriptions.add(context.commands.register(`${id}.failure`, () => {
    throw new Error('Private plugin error')
  }))
  context.subscriptions.add(context.commands.register(`${id}.invalid`, () => Number.NaN))
  context.subscriptions.add(context.commands.register(`${id}.timeout`, () => new Promise(() => {})))
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

async function mediaSettings(pluginId, context, container) {
  container.dataset.contributionFixture = `${pluginId}.settings`
  container.innerHTML = '<button>Download wallpaper</button><img alt="Downloaded wallpaper"><a>Source</a><p role="status">Ready</p>'
  const status = container.querySelector('[role=status]')
  window.fixture = { ready: true, resource: null, themeId: null }
  container.querySelector('button').onclick = async () => {
    try {
      status.textContent = 'Downloading'
      const file = await context.commands.execute(`${pluginId}.download`, { url: 'https://media.example.com/wallpaper.svg' })
      window.fixture.resource = file
      const image = container.querySelector('img')
      image.src = await context.resources.getUrl(file)
      await image.decode()
      const theme = await context.themes.save({ schemaVersion: 1, label: 'Downloaded wallpaper', appearance: 'dark', document: { schemaVersion: 1, welcome: { image: 'wallpaper.svg' } }, assets: { 'wallpaper.svg': { resourceId: file.id } } })
      await context.resources.release(file)
      await context.themes.setPreference({ id: theme.id })
      window.fixture.themeId = theme.id
      status.textContent = 'Saved'
    }
    catch (error) { status.textContent = error.message }
  }
  container.querySelector('a').onclick = () => context.openExternal('https://media.example.com/source#credits')
  container.querySelector('a').textContent = 'Source'
}
