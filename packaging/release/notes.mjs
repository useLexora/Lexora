export function createReleaseNotesDraft(generatedNotes) {
  const source = generatedNotes.trim().replace(/^(#{1,5}) /gm, '#$1 ')
  return `<!--
以下自动生成的条目是评审素材。整理为面向用户的中文说明，并补齐顺序一致的英文。
按需使用三级标题：升级提醒 / Upgrade notes、新增 / Added、改进 / Improved、修复 / Fixed；省略空分类。
合并重复改动，说明用户可感知的结果；涉及平台限制、升级操作或破坏性变化时在两种语言中明确写出。
-->
## 中文

${source}

## English

<!-- Write the English translation with the same scope and entry order as the reviewed Chinese notes. -->
`
}

export function validateReleaseNotes(notes) {
  const errors = []
  if (typeof notes !== 'string')
    return ['release notes must contain reviewed Chinese and English text']
  const content = notes.replace(/<!--[\s\S]*?-->/g, '').trim()
  const sections = content.split(/^## (中文|English)\s*$/m)
  if (sections.length !== 5 || sections[0].trim() || sections[1] !== '中文' || sections[3] !== 'English')
    errors.push('release notes must contain exactly two language sections: ## 中文 followed by ## English')
  else if ([sections[2], sections[4]].some(section => !section.replace(/^#{1,6}\s.*$/gm, '').trim()))
    errors.push('both Chinese and English release notes must be non-empty')
  return errors
}
