# cap-primitives 本地补丁

基于 crates.io 的 `cap-primitives` 4.0.3，只改了一处：

- `src/windows/fs/get_path.rs`：`get_path` 把 `\\?\UNC\server\share\...` 去前缀后得到无效的 `UNC\server\share\...`，导致 `\\wsl.localhost\...` 这类网络路径下列目录、创建目录、复制、删除目录树都失败。现在 `\\?\UNC\` 会还原成 `\\`，并附单元测试（仅 Windows 目标编译）。

升级 `cap-primitives` 时先确认上游已修复该问题；已修复则删除本目录和根 `Cargo.toml` 里的 `[patch.crates-io]`。
