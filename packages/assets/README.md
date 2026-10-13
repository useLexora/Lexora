# Lexora Assets

`packages/assets` 存放 Lexora 跨应用复用的品牌与产品资产。这里的文件是应用可直接消费的最终资产或可追溯参考源。

## 当前结构

- `brand/lexora-avatar.png`：Lexora 的高清品牌头像，带简约青蓝背景，README 直接消费它。
- `brand/lexora-avatar-classic.png`：古典形象的高清备份。
- `brand/app-icon.png`：基于新 Lexora 头像的应用图标。
- `brand/tray-icon.png`：同一新形象的小尺寸托盘图标，保留独立资源。
- `sources/default-reference.png`：默认 Buddy 的初始参考原图，带粉色背景，不是运行时资源。
- `buddy/pets/default/pet.png`：透明静态角色图，用于桌宠预览和动画身份参考；它是派生物，不是 native 桌宠运行时入口。
- `buddy/pets/default/manifest.json`：Buddy 默认形象的帧尺寸、sheet 布局和语义动画契约；`animations` 是数组，每个动作条目包含 `name`、`description`、`row` 和自己的 `frames`。
- `buddy/pets/default/spritesheet.webp`：Buddy 默认形象的运行时雪碧图，native 桌宠加载它并按帧裁切。

## 边界

- 未被产品直接消费的原图、可编辑源和参考材料放在 `sources/` 下。
- 应用直接消费的最终品牌与身份资产放在 `brand/`。
- 派生出的 Buddy 运行时资源放在 `buddy/pets/<id>/`。
- `apps/buddy/resources/brand/lexora-avatar.png` 是 Buddy 启动页使用的品牌头像副本；发布校验保证它与 `brand/lexora-avatar.png` 字节一致。
- `apps/buddy/resources/icons/app-icon.png` 是窗口、界面及安装包使用的应用图标副本，与 `brand/app-icon.png` 字节一致。
- `apps/buddy/resources/icons/tray-icon.png` 是独立的托盘图标副本，与 `brand/tray-icon.png` 字节一致。
- 本地候选图、私有源、临时 sheet 和生成脚本不是最终资产，不放在这个包的公开结构里。
