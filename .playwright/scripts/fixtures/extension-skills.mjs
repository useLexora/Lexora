import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const { strToU8, zipSync } = createRequire(new URL('../../../apps/buddy/package.json', import.meta.url))('fflate/node')

export const skillPluginId = 'tests.skill-workbook'
export const skillInvocationName = 'skill-workbook:workbook'
export const skillPluginName = '工作簿技能验收插件'
export const userSkillContent = '---\nname: workbook\ndescription: Independent user workbook instructions.\n---\n\nKeep the independent user workbook skill.\n'
const pluginSkillFiles = {
  'SKILL.md': '---\nname: workbook\ndescription: Inspect workbook files with the packaged workbook guide.\n---\n\n# Packaged workbook guide\n\nRead [the workbook reference](references/workbook.md).\n',
  'references/workbook.md': '# Workbook reference\n\nPreserve formulas when inspecting a workbook.\n',
}

export async function writeSkillPlugin(directory) {
  const manifest = {
    schemaVersion: 1,
    id: skillPluginId,
    name: skillPluginName,
    version: '1.0.0',
    apiVersion: 4,
    engines: { lexora: '>=0.15.0' },
    contributes: { skills: [{ id: `${skillPluginId}.workbook`, path: 'skills/workbook/SKILL.md' }] },
  }
  const archive = path.join(directory, 'workbook.lexora-extension')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(archive, zipSync({
    'extension.json': strToU8(JSON.stringify(manifest)),
    ...Object.fromEntries(Object.entries(pluginSkillFiles).map(([name, content]) => [`skills/workbook/${name}`, strToU8(content)])),
  }))
  const userSource = path.join(directory, 'user-workbook')
  await fs.mkdir(userSource, { recursive: true })
  await fs.writeFile(path.join(userSource, 'SKILL.md'), userSkillContent)
  return { archive, userSource }
}
