package app.uselexora.mobile.ui

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import java.util.Locale

internal object ApkInstall {
    const val MIME = "application/vnd.android.package-archive"

    fun matches(name: String, mime: String): Boolean = mime.lowercase(Locale.ROOT) == MIME || name.endsWith(".apk", ignoreCase = true)

    fun allowed(context: Context): Boolean = context.packageManager.canRequestPackageInstalls()

    fun settings(context: Context): Intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))

    fun intent(uri: Uri, name: String): Intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, MIME).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        clipData = ClipData.newRawUri(name, uri)
    }
}
