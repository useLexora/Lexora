package app.uselexora.mobile.network

import app.uselexora.mobile.protocol.ProtocolFailure
import android.content.Context
import app.uselexora.mobile.storage.LocalFiles
import app.uselexora.mobile.storage.TransferStore
import java.io.EOFException
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import org.json.JSONObject

internal data class DownloadSpec(val resource: String, val version: String, val size: Long, val name: String, val mime: String) {
    fun bind(record: DownloadRecord): DownloadRecord {
        if (resource != record.resourceId || (record.contentVersion != null && (record.contentVersion != version || record.totalBytes != size))) throw ProtocolFailure("VERSION_CHANGED")
        return record.copy(contentVersion = version, totalBytes = size, name = name, mimeType = mime)
    }
    companion object {
        fun parse(value: JSONObject): DownloadSpec {
            val version = value.getString("contentVersion")
            val size = value.getString("sizeBytes").toLongOrNull()
            if (!version.matches(Regex("[a-f0-9]{64}")) || size == null || size < 0) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
            return DownloadSpec(value.getString("resourceId"), version, size,
                LocalFiles.downloadName(value.getString("name")).trim('.',' ').ifBlank { "download" }, value.getString("mimeType").ifBlank { "application/octet-stream" })
        }
    }
}

internal object DownloadBytes {
    const val RANGE = 1024 * 1024L
    fun length(offset: Long, size: Long): Long {
        require(offset in 0 until size)
        return minOf(RANGE, size - offset)
    }
    fun copy(input: InputStream, output: OutputStream, count: Long, buffer: ByteArray, check: () -> Unit) {
        var left = count
        while (left > 0) {
            check()
            val n = input.read(buffer, 0, minOf(left, buffer.size.toLong()).toInt())
            if (n <= 0) throw EOFException()
            try { output.write(buffer, 0, n) } catch (e: java.io.IOException) { throw ProtocolFailure("LOCAL_STORAGE_FAILED", e) }
            left -= n
        }
    }
    fun verify(input: InputStream, size: Long, hash: String, check: () -> Unit): Boolean {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        var left = size
        while (left > 0) {
            check()
            val n = input.read(buffer, 0, minOf(left, buffer.size.toLong()).toInt())
            if (n <= 0) return false
            digest.update(buffer, 0, n); left -= n
        }
        check()
        return input.read() == -1 && MobileFiles.hex(digest.digest()) == hash
    }
    fun fetch(transport: PinnedTransport, credential: String, downloadId: String, spec: DownloadSpec, offset: Long,
              output: OutputStream, buffer: ByteArray, check: () -> Unit) {
        if (!downloadId.matches(Regex("[A-Za-z0-9_-]{1,128}"))) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
        val n = length(offset, spec.size)
        val end = offset + (n - 1)
        val etag = "\"${spec.version}\""
        transport.request("/v1/resources/$downloadId", credential = credential, headers = mapOf("If-Match" to etag,
            "Range" to "bytes=$offset-$end", "Accept-Encoding" to "identity")).use { response ->
            if (response.code != 206) {
                val code = runCatching { JSONObject(response.peekBody(4096).string()).optString("error") }.getOrNull()
                throw ProtocolFailure(code?.takeIf { it in setOf("VERSION_CHANGED", "NOT_AUTHORIZED", "RESOURCE_UNAVAILABLE", "LIMIT_EXCEEDED") } ?: "RESOURCE_UNAVAILABLE")
            }
            val body = response.body ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
            if (response.header("ETag") != etag) throw ProtocolFailure("VERSION_CHANGED")
            if (response.header("Content-Range") != "bytes $offset-$end/${spec.size}" || body.contentLength() != n) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
            val stream = body.byteStream()
            copy(stream, output, n, buffer, check)
            if (stream.read() != -1) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
        }
    }
}

internal class DownloadCacheSource(val spec: DownloadSpec, val stream: FileInputStream) : AutoCloseable {
    override fun close() = stream.close()
    companion object {
        fun open(context: Context, transfers: TransferStore, record: DownloadRecord, check: () -> Unit): DownloadCacheSource? {
            val directory = File(context.filesDir, "exports")
            if (java.nio.file.Files.isSymbolicLink(directory.toPath()) || directory.canonicalFile.parentFile != context.filesDir.canonicalFile) return null
            for (entry in transfers.list(record.partition)) {
                if (entry.optString("kind") != "download" || entry.optString("state") != "ready" || entry.optString("resourceId") != record.resourceId || entry.optString("expectedVersion") != record.revision) continue
                val id = entry.getString("id"); if (!LocalFiles.validId(id)) continue
                val prepared = entry.optJSONObject("prepared") ?: continue
                val spec = runCatching {
                    DownloadSpec.parse(JSONObject(prepared.toString()).apply { if (!has("resourceId")) put("resourceId", record.resourceId) })
                }.getOrNull() ?: continue
                if (spec.resource != record.resourceId || spec.size !in 0..MobileFiles.MAX_BYTES || spec.version != entry.optString("contentVersion")) continue
                val file = File(directory, "$id-${LocalFiles.downloadName(prepared.getString("name"))}")
                if (file.absolutePath != entry.optString("path") || java.nio.file.Files.isSymbolicLink(file.toPath()) ||
                    file.canonicalFile.parentFile != directory.canonicalFile || !file.isFile || file.length() != spec.size) continue
                val stream = try { FileInputStream(file) } catch (_: java.io.FileNotFoundException) { continue }
                try {
                    if (DownloadBytes.verify(stream, spec.size, spec.version, check)) {
                        stream.channel.position(0); return DownloadCacheSource(spec, stream)
                    }
                } catch (e: Exception) { stream.close(); throw e }
                stream.close()
            }
            return null
        }
    }
}
