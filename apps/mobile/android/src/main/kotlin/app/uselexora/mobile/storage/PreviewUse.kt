package app.uselexora.mobile.storage

import app.uselexora.mobile.protocol.ProtocolFailure
import java.io.Closeable
import java.io.File

internal object PreviewUse {
    private val readers = mutableMapOf<File, Int>()
    fun open(file: File): Closeable {
        val key = file.canonicalFile
        synchronized(readers) {
            if (!key.isFile) throw ProtocolFailure("RESOURCE_UNAVAILABLE")
            readers[key] = readers.getOrDefault(key, 0) + 1
        }
        return Closeable {
            synchronized(readers) {
                val count = readers.getValue(key)
                if (count == 1) readers.remove(key) else readers[key] = count - 1
            }
        }
    }
    fun held(key: File) = synchronized(readers) { key in readers }
    fun delete(key: File) = synchronized(readers) {
        if (key in readers) throw ProtocolFailure("LOCAL_FILE_IN_USE")
        if (!key.delete()) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
    }
}
