package app.uselexora.mobile.ui

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

@Composable
internal fun rememberPartnerAvatars(owner: ReaderAvatars?, topic: String, ids: Set<String>): Map<String, String> {
    var sources by remember(owner, topic) { mutableStateOf(owner?.sources.orEmpty()) }
    DisposableEffect(owner, topic, ids) {
        val key = Any()
        sources = owner?.sources.orEmpty()
        owner?.observe(key, ids) { sources = owner.sources }
        onDispose { owner?.remove(key) }
    }
    return sources
}

@Composable
internal fun PartnerAvatar(id: String, name: String, source: String?, loader: ReaderAvatars?) {
    val context = LocalContext.current
    val bitmap by produceState<ImageBitmap?>(null, id, source, loader) {
        value = null
        value = withContext(Dispatchers.IO) {
            runCatching {
                val image = if (source != null && !source.startsWith("preset:")) {
                    loader?.asset(Uri.parse(source))?.data?.use { BitmapFactory.decodeStream(it) }
                } else {
                    val manifest = context.assets.open("reader/avatar-presets.json").bufferedReader().use { JSONObject(it.readText()) }
                    val preset = source?.removePrefix("preset:") ?: when (id) {
                        "default" -> "actor-lexora"
                        "npc-explorer", "npc-researcher", "npc-executor", "npc-reviewer" -> id
                        else -> "npc-slate"
                    }
                    val path = manifest.optString(preset).takeIf { it.startsWith("assets/") && ".." !in it } ?: return@runCatching null
                    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    context.assets.open("reader/$path").use { BitmapFactory.decodeStream(it, null, options) }
                    options.inJustDecodeBounds = false
                    options.inSampleSize = 1
                    while (maxOf(options.outWidth, options.outHeight) / options.inSampleSize > 256) options.inSampleSize *= 2
                    context.assets.open("reader/$path").use { BitmapFactory.decodeStream(it, null, options) }
                }
                image?.asImageBitmap()
            }.getOrNull()
        }
    }
    Box(Modifier.size(40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainer).testTag("partner-avatar-$id"), contentAlignment = Alignment.Center) {
        val loaded = bitmap
        if (loaded != null) Image(loaded, null, Modifier.size(40.dp).testTag("partner-image-$id"), contentScale = ContentScale.Crop)
        else Text(name.take(1), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
