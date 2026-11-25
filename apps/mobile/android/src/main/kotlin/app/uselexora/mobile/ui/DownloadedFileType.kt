package app.uselexora.mobile.ui

import android.content.ContentResolver
import android.net.Uri
import android.webkit.MimeTypeMap
import java.util.Locale

internal fun ContentResolver.downloadedMime(uri: Uri, name: String, declared: String): String {
    val generic = "application/octet-stream"
    fun specific(type: String?) = type?.substringBefore(';')?.trim()?.lowercase(Locale.ROOT)
        ?.takeIf { it.isNotBlank() && it != generic && '*' !in it }
    return specific(getType(uri)) ?: specific(declared) ?: MimeTypeMap.getSingleton()
        .getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase(Locale.ROOT)) ?: generic
}
