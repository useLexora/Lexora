# 主题

主题包使用 API 3，可提供多个主题，无需 `entry`、视图或额外权限：

```json
{
  "schemaVersion": 1,
  "id": "author.ocean",
  "name": "Ocean",
  "version": "1.0.0",
  "apiVersion": 3,
  "engines": { "lexora": ">=0.10.1" },
  "contributes": {
    "themes": [
      { "id": "author.ocean.day", "label": "Ocean Day", "appearance": "light", "path": "themes/day.json" },
      { "id": "author.ocean.night", "label": "Ocean Night", "appearance": "dark", "path": "themes/night.json" }
    ]
  }
}
```

名称、ID、明暗类型在清单中声明；主题 JSON 只保存外观。安装不会自动切换主题，用户在设置的单个列表中选择主题，列表按浅色、深色分组。选择具体主题时固定其外观；选择“跟随系统”时自动切换默认浅色、默认深色主题，无需分别配置两套主题。

```json
{
  "schemaVersion": 1,
  "colors": { "canvas": "#f5fafc", "fg": "#284657", "accent": "#247aaa" },
  "welcome": {
    "text": { "zh-CN": "从一个想法开始。", "en-US": "Start with an idea." },
    "image": "assets/welcome.png"
  },
  "materials": [{
    "anchor": "app.sidebar",
    "gradient": { "angle": 160, "stops": [{ "color": "#c9eaf980", "at": 0 }, { "color": "#c9eaf900", "at": 100 }] }
  }]
}
```

颜色使用 `#RRGGBB` 或 `#RRGGBBAA`。完整键与范围见 `ThemeDocument` 类型或 `themes.describe()` 返回的 JSON Schema。缺失值由明暗基础主题与已合并的颜色派生；显式 hover、selected、selected-hover、pressed 等值优先。状态颜色、编辑器与语法、终端、正文、侧栏、输入框可以分别配置。主题不改变用户字号、行高、分屏尺寸、键盘行为或 Space 标记色。

图片只能引用包内 PNG/JPEG/WebP/SVG；不得使用绝对路径、远端 URL、CSS 或脚本。材质锚点为 `app.sidebar`、`workbench.sidebar`、`workbench.pane`、`composer.input`，每个最多一层，支持图片、底色、渐变覆盖、0–1 透明度、0–24 模糊、百分比位置与 cover/contain。`imageOpacity` 独立控制图片透明度，`scale` 在适配尺寸上缩放 0.1–2 倍。透明度只作用于背景，背景不接收点击。动画与交互内容使用普通隔离视图扩展点。

声明 `welcome` 后由主题提供欢迎内容，不受内置欢迎语选项影响；文字或图片省略、设为 `null` 时均不显示对应内容。不声明 `welcome` 就沿用用户选择的内置欢迎内容。`task.welcome` 是独立的整体内容插槽，可承载工具、导航或其他界面；已就绪的插槽插件优先，加载失败时回退到主题或内置欢迎内容。

## 为编辑器提供的 API

宿主与视图上下文都提供 `context.themes`，无需访问宿主 DOM。

- `list/get/getActive` 读取主题目录、文档与当前快照；`onDidChange` 订阅变化。
- `describe/validate/resolve` 获取结构、校验诊断与合并覆盖后的解析结果。
- `save(archive, id?)` 保存用户主题；省略 ID 创建新副本，包内主题保持只读。
- `remove(id)` 删除用户主题。选择仍保留，直到再次可用或用户改选。
- `setPreference({ id })` 保存当前主题；`id: 'system'` 表示跟随系统。
- `beginPreview(archive)` 返回 `{token, revision}`；更新后使用 `updatePreview` 返回的新版本；`commitPreview` 保存为用户主题并选中；`cancelPreview(token)` 撤销。其他选择或新的预览使旧租约失效，插件卸载／关闭或应用重启不会保存未提交的预览。
- `export(id)` 返回自包含 JSON 文本，`import(text)` 创建用户副本。`ThemeArchive.assets` 按相对路径保存图片 base64，最多 16 张，单图 4 MiB，整个传输 16 MiB。宿主持有副本，不依赖编辑器插件持续存在。

修改、导入或预览需要 `permissions.themeManagement: true`。导入文件通过视图 `resources.pickFiles/readText`；导出通过 `resources.saveFile({name: 'ocean.lexora-theme', data: new Blob([await context.themes.export(id)])})`，分别声明现有 `localResources` 与 `resourceExport` 权限。主题 API 不接受任意文件路径。

插件自身界面仍可使用 `styles: {"uno": true}` 和语义工具类，随主题更新变量，无需重建视图。禁止向宿主注入任意选择器或主题脚本。
