import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val versionProperties = Properties().apply {
    file("version.properties").inputStream().use { load(it) }
}
val mobileVersionName = requireNotNull(versionProperties.getProperty("versionName")) {
    "version.properties must define versionName"
}
require(Regex("""(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-beta\.([1-9][0-9]*))?""").matches(mobileVersionName)) {
    "versionName must use x.y.z or x.y.z-beta.N without leading zeroes (N > 0)"
}
val mobileVersionCode = requireNotNull(versionProperties.getProperty("versionCode")?.toIntOrNull()) {
    "version.properties must define an integer versionCode"
}
require(mobileVersionCode in 1..2_100_000_000) { "versionCode must be between 1 and 2100000000" }

android {
    namespace = "app.uselexora.mobile"
    compileSdk = 36
    bundle { language { enableSplit = false } }
    defaultConfig {
        applicationId = "app.uselexora.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = mobileVersionCode
        versionName = mobileVersionName
        buildConfigField("boolean", "PROBE_ENABLED", "false")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        create("release") {
            System.getenv("LEXORA_ANDROID_KEYSTORE")?.let { storeFile = file(it) }
            storePassword = System.getenv("LEXORA_ANDROID_STORE_PASSWORD")
            keyAlias = System.getenv("LEXORA_ANDROID_KEY_ALIAS")
            keyPassword = System.getenv("LEXORA_ANDROID_KEY_PASSWORD")
        }
    }
    buildTypes {
        debug { applicationIdSuffix = ".dev"; buildConfigField("boolean", "PROBE_ENABLED", "true") }
        release {
            isMinifyEnabled = true
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    buildTypes.create("benchmark") {
        initWith(buildTypes.getByName("release"))
        applicationIdSuffix = ".benchmark"
        signingConfig = signingConfigs.getByName("debug")
        buildConfigField("boolean", "PROBE_ENABLED", "true")
        matchingFallbacks += "release"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    buildFeatures { buildConfig = true; compose = true }
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/protocol").get().asFile)
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/reader").get().asFile)
    sourceSets["main"].res.srcDir(layout.buildDirectory.dir("generated/brand").get().asFile)
}

val verifyResources by tasks.registering(Exec::class) {
    workingDir(rootProject.projectDir)
    commandLine("node", "--test", "tools/__tests__/localization.spec.mjs")
}
tasks.withType<Test>().configureEach { dependsOn(verifyResources) }

val verifyProtocolSchema by tasks.registering(Exec::class) {
    workingDir(rootProject.projectDir)
    commandLine("node", "--test", "tools/__tests__/protocol-schema.spec.mjs")
}
val syncProtocol by tasks.registering(Exec::class) {
    dependsOn(verifyProtocolSchema)
    workingDir(rootProject.projectDir)
    commandLine("node", "tools/export-protocol.mjs", layout.buildDirectory.dir("generated/protocol").get().asFile.absolutePath)
    inputs.dir(rootProject.file("tools"))
    inputs.dir(rootProject.file("../buddy/shared"))
    inputs.file(rootProject.file("../buddy/src/mobile-reader/readerProtocol.ts"))
    inputs.file(rootProject.file("../buddy/package.json"))
    inputs.file(rootProject.file("../../pnpm-lock.yaml"))
    outputs.dir(layout.buildDirectory.dir("generated/protocol"))
}
val syncBrand by tasks.registering(Sync::class) {
    from(rootProject.file("../../packages/assets/brand/app-icon.png")) {
        into("mipmap-nodpi")
        rename { "ic_lexora.png" }
    }
    into(layout.buildDirectory.dir("generated/brand").get().asFile)
}
val readerDirectory = rootProject.file("../buddy/.output/build/mobile-reader")
val buildReader by tasks.registering(Exec::class) {
    workingDir(rootProject.file("../buddy"))
    commandLine("pnpm", "build:mobile-reader")
    inputs.dir(rootProject.file("../buddy/src"))
    inputs.dir(rootProject.file("../buddy/shared"))
    inputs.file(rootProject.file("../buddy/uno.config.ts"))
    inputs.file(rootProject.file("../buddy/mobile-reader.vite.config.ts"))
    inputs.file(rootProject.file("../buddy/package.json"))
    for (mode in listOf("light", "dark")) inputs.file(rootProject.file("../buddy/extensions/bundled/lexora.themes/themes/classic-$mode.json"))
    inputs.file(rootProject.file("../../pnpm-lock.yaml"))
    outputs.dir(readerDirectory)
}
val syncReader by tasks.registering(Sync::class) {
    dependsOn(buildReader)
    from(readerDirectory) { into("reader") }
    into(layout.buildDirectory.dir("generated/reader"))
}
tasks.named("preBuild").configure { dependsOn(syncProtocol, syncBrand, syncReader) }

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.08.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("com.mikepenz:multiplatform-markdown-renderer-android:0.37.0")
    implementation("com.mikepenz:multiplatform-markdown-renderer-m3-android:0.37.0")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    implementation("androidx.core:core:1.16.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    androidTestImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
