# Lexora for Android

Android 客户端连接已启用移动访问的 Lexora Core 服务。任务由服务执行；手机保存本地输入、发件记录和配对凭据。

需要仓库要求的 Node.js、pnpm、JDK 17 或更新版本，以及 Android SDK 36。先在仓库根目录运行 `pnpm install`；Gradle 构建时会一起打包本地对话页面。配置 `JAVA_HOME` 和 `ANDROID_HOME` 后，在本目录运行：

```sh
./gradlew :android:assembleDebug
./gradlew :android:testDebugUnitTest :android:connectedDebugAndroidTest
```

开发 APK 位于 `android/build/outputs/apk/debug/`。正式构建运行 `./gradlew :android:assembleRelease`，通过 `LEXORA_ANDROID_KEYSTORE`、`LEXORA_ANDROID_STORE_PASSWORD`、`LEXORA_ANDROID_KEY_ALIAS` 和 `LEXORA_ANDROID_KEY_PASSWORD` 提供签名。签名文件和密码应独立保管；手动更新使用同一签名。

安装 APK 后，在 Lexora 桌面端启用服务的移动访问并显示配对二维码，手机点击“扫码连接”。手机与服务需处于可互通的局域网或私网。身份不匹配时，请核对服务的配对二维码；不要向不同身份的地址提交旧凭据。

App 默认在后台保持与服务的连接，并显示一条常驻通知；前台使用时由界面接管这条连接，离开应用后继续在后台连接，并提醒需要你处理的审批、提问和未读结果。手机系统的后台限制仍可能冻结或结束应用，这种情况下后台提醒会中断，属于移动端保活的固有边界；可在设置里关闭“在后台保持连接”，改为仅前台连接。回前台后重新连接并核对任务；“回执待确认”时查询原发件记录，避免重复提交。提醒只来自当前选中的服务，服务不在同一网络或已断开时不会收到，也不做云端推送。清除 App 数据或重装后需要重新配对。
