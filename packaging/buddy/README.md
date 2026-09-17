# Lexora Buddy Packaging

本目录提供 Lexora Buddy 桌面安装包与独立桌宠的构建入口。产品说明见 [`apps/buddy/README.md`](../../apps/buddy/README.md)。

## 构建

| 产物 | 命令 |
| --- | --- |
| Ubuntu x64 / ARM64 deb | `pnpm --filter @uselexora/lexora-buddy package:deb` |
| Arch Linux x64 pacman | `pnpm --filter @uselexora/lexora-buddy package:arch` |
| Windows x64 / ARM64 NSIS | `pnpm --filter @uselexora/lexora-buddy package:windows` |
| macOS 26+ ARM64 DMG | `pnpm --filter @uselexora/lexora-buddy package:macos` |
| Linux x64 / ARM64 独立桌宠 | `pnpm --filter @uselexora/lexora-buddy package:pet` |

产物写入 `apps/buddy/.output/artifacts/`。桌面安装包内置 fd、ripgrep 与原生组件，Linux 还内置 Shell 沙箱 helper。构建需要 Rust 工具链；Linux 还需要 C 编译器、Meson、Ninja、libcap 开发包，运行沙箱需要 socat，包校验需要 `bsdtar`。Windows 构建需要 MSVC C++ Build Tools 与 Windows SDK；macOS 需要 Xcode Command Line Tools。各平台安装包在对应系统和 CPU 架构上构建和验证。

macOS 默认使用 ad-hoc 签名，无需 Apple 开发者证书。将 DMG 中的 `lexora-buddy.app` 拖入「应用程序」后，在终端运行以下命令，再打开应用。仅对从本项目 Release 下载或自行构建的应用执行：

```bash
xattr -r -d com.apple.quarantine "/Applications/lexora-buddy.app"
```

安装包未经过 Apple 公证；更新后如再次被系统阻止，重新执行上述命令。

## 校验

```bash
pnpm release:version:check
pnpm --filter @uselexora/lexora-buddy lint
pnpm --filter @uselexora/lexora-buddy type-check
pnpm --filter @uselexora/lexora-buddy test
pnpm check:buddy
```

`check:buddy` 是本地完整预检，包含质量检查、当前平台安装包构建和测试。
