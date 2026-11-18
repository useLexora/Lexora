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
internal fun rememberPartnerAvatars(owner: ReaderAvatarContext?, topic: String, ids: Set<String>): Pair<ReaderAvatars?, Map<String, String>> {
    val context = LocalContext.current
    var sources by remember(owner?.partition) { mutableStateOf(emptyMap<String, String>()) }
    val loader = remember(owner?.partition, owner?.schemas) {
        owner?.let {
            lateinit var result: ReaderAvatars
            result = ReaderAvatars(context, it.schemas) { sources = result.sources }
            result
        }
    }
    DisposableEffect(loader) { onDispose { loader?.close() } }
    LaunchedEffect(loader, owner?.client, topic, ids) {
        if (owner != null) loader?.update(owner.partition, topic, owner.client, ids)
    }
    return loader to sources
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
