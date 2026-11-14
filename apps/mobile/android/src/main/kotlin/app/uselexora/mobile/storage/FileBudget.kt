package app.uselexora.mobile.storage

import app.uselexora.mobile.protocol.ProtocolFailure
import java.io.File
import java.nio.file.Files

class FileBudget(private val root: File) {
    data class Capacity(val used: Long, val remaining: Long, val freeDisk: Long) {
        fun requireAdditional(bytes: Long) {
            if (bytes < 0 || bytes > remaining) throw ProtocolFailure("LOCAL_CACHE_FULL")
            if (bytes > freeDisk) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
        }
    }
    fun capacity(): Capacity {
        val used = listOf("staging", "exports").sumOf { name -> ownedFiles(File(root, name), root).sumOf { it.length() } }
        return Capacity(used, (MAX_BYTES - used).coerceAtLeast(0), (root.usableSpace - MIN_FREE_BYTES).coerceAtLeast(0))
    }
    companion object {
        const val MAX_BYTES = 256L * 1024 * 1024
        const val MIN_FREE_BYTES = 8L * 1024 * 1024
        fun ownedFiles(directory: File, parent: File): List<File> {
            if (directory.canonicalFile.parentFile != parent.canonicalFile || Files.isSymbolicLink(directory.toPath())) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
            if (!directory.exists()) return emptyList()
            val files = directory.listFiles() ?: throw ProtocolFailure("LOCAL_STORAGE_FAILED")
            return files.filter { it.isFile && !Files.isSymbolicLink(it.toPath()) && it.canonicalFile.parentFile == directory.canonicalFile }
        }
    }
}
