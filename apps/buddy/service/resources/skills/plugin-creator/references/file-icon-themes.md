# 文件图标主题

文件图标独立于界面配色。用户安装并启用插件后，在「设置 → 外观 → 文件图标」选择；禁用或卸载插件会恢复内置图标并保留选择，重新启用或安装后恢复。

在 API 3 清单中添加贡献（ID 使用已有插件 ID 前缀）：

```json
{
  "contributes": {
    "iconThemes": [
      { "id": "author.icons.palette", "label": "Palette", "path": "themes/icons.json" }
    ]
  }
}
```

纯图标包只需 `extension.json`、主题 JSON 与图片，无需 `entry`、权限或设置页。每个包最多 32 个图标主题。

`themes/icons.json`：

```json
{
  "iconDefinitions": {
    "file": { "iconPath": "../icons/file.svg" },
    "typescript": { "iconPath": "../icons/typescript.svg" },
    "folder": { "iconPath": "../icons/folder.svg" },
    "folder-open": { "iconPath": "../icons/folder-open.svg" },
    "folder-light": { "iconPath": "../icons/folder-light.svg" }
  },
  "file": "file",
  "folder": "folder",
  "folderExpanded": "folder-open",
  "fileExtensions": { "ts": "typescript", "d.ts": "typescript" },
  "fileNames": { "tsconfig.json": "typescript" },
  "folderNames": { "src": "folder" },
  "folderNamesExpanded": { "src": "folder-open" },
  "light": { "folder": "folder-light" }
}
```

- 图片路径相对主题 JSON，允许 `../icons/…`，但最终必须在包内。支持 SVG、PNG、JPEG、WebP，单图最多 256 KiB；不接受网络地址、绝对路径、脚本或字体图标。主题 JSON 最多 2 MiB、4096 个图片定义。
- 匹配不区分大小写。文件名优先于扩展名，多段扩展名优先于较短扩展名；`src/index.ts`、`src/ts` 可限制直接父目录。`languageIds` 在消费方提供语言 ID 时参与匹配，最后使用 `file`。映射值必须引用已声明的图片定义。
- 目录支持名称、展开状态和根目录映射；省略展开图标时使用对应的折叠图标。未提供的图标回退到内置主题。
- 默认映射用于深色外观，`light` 按字段及名称覆盖浅色外观；切换界面配色时自动更新。`highContrast` 映射可保留，当前界面尚无独立高对比外观选项。`hidesExplorerArrows: true` 可隐藏文件树折叠箭头，点击目录和键盘展开仍可使用。
- 图片按需读取，不运行插件脚本。替换或停用包后旧图片地址失效；损坏资源回退到内置图标。

这些字段借鉴 [VS Code 文件图标主题](https://code.visualstudio.com/api/extension-guides/file-icon-theme)。迁移时提取需要的图片及映射，添加 Lexora 清单，并保留原始许可证和署名；不支持直接安装 VSIX，也不支持字体图标或 Product Icon Theme。完整字段见 `FileIconThemeDocument`。
