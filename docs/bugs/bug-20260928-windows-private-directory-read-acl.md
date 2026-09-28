# Bug：Windows 私有目录拒绝 Agent 的只读权限

**日期：** 2026-09-28<br>
**优先级：** 中
**状态：** 已修复

## 复现步骤

1. 在 Windows 安装并启动 Lexora Buddy。
2. 使用 Codex Windows 沙盒，让其为用户配置目录下的 `.lexora` 添加沙盒用户读取权限。
3. 启动 Lexora Buddy；移除该权限后，Codex 沙盒再次补回权限时，问题会重现。

## 实际结果

应用启动失败并提示 `PRIVATE_DIRECTORIES_UNSAFE`，失败步骤为 `validate_acl / lexora_home`。本机诊断中的 ACL 为：`principal=other`、`mask=0x1200a9`、`flags=0x3`。这条允许读取和遍历目录的权限被当成不安全权限拒绝。

## 预期结果

仅有读取、列目录、读取属性和遍历权限的额外主体不应阻止应用启动。额外主体仍不得通过 ACL 获得写入、删除或其他修改能力。

## 影响范围

Windows 桌面版启动时对 `lexora_home`（Lexora 用户数据根目录）的 ACL 检查。任何 Agent 或其他工具为该目录添加只读权限时，都可能触发原问题。

## 初步判断

`CodexSandboxUsers` 是 Codex Windows 沙盒使用的主体。Codex 为用户配置目录补充读取权限后，Lexora 原先只接受元数据读取权限，并拒绝可读取目录内容的权限，因此两种安全策略发生冲突。ACL 表示该主体具备读取能力，不代表它实际读取过目录内容。

| 名称 | 含义 |
|---|---|
| `lexora_home` | Lexora 保存用户数据的根目录 |
| `validate_acl` | 检查 Windows 目录访问控制列表的启动步骤 |
| `CodexSandboxUsers` | Codex Windows 沙盒使用的本地组 |
| `mask=0x1200a9` | 该权限允许读取目录内容、读取属性、遍历目录等，不含写入权限 |
| `flags=0x3` | 权限可继承给子文件和子目录 |

## 处理方式

Windows ACL 校验现在允许额外主体拥有只读、列目录、读取属性和执行/遍历权限；仍拒绝含写入等修改权限的 ACL。规则按权限类型生效，不专门信任 Codex 组。

**安全影响：** 获得这些只读权限的主体可以读取 `.lexora` 中的文件。此修复没有迁移或另行保护目录中的数据。

**验收记录：** Windows 原生测试 43 项通过；Rust 格式检查通过；Windows 安装包已重新生成。

相关实现：`apps/buddy/native/host/src/private_directories/windows/security.rs`。
相关测试：`apps/buddy/native/host/__tests__/private_security_windows.rs`。
