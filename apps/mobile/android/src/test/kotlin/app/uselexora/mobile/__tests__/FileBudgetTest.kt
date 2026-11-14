package app.uselexora.mobile

import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.storage.FileBudget
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class FileBudgetTest {
    @Test fun countsStoredBytesIncludingPartialFilesWithoutFollowingLinks() {
        val root = Files.createTempDirectory("mobile-budget").toFile()
        try {
            val staging = File(root, "staging").apply { mkdir() }
            val exports = File(root, "exports").apply { mkdir() }
            File(staging, "input").writeBytes(ByteArray(7))
            File(exports, "download.part").writeBytes(ByteArray(11))
            val outside = File(root, "input.db").apply { writeBytes(ByteArray(23)) }
            Files.createSymbolicLink(File(staging, "link").toPath(), outside.toPath())
            val capacity = FileBudget(root).capacity()
            assertEquals(18L, capacity.used)
            assertEquals(FileBudget.MAX_BYTES - 18, capacity.remaining)
        } finally { root.deleteRecursively() }
    }
    @Test fun directoryLinksCannotExpandTheStorageBoundary() {
        val root = Files.createTempDirectory("mobile-budget").toFile()
        val outside = Files.createTempDirectory("mobile-outside").toFile()
        try {
            File(outside, "keep").writeText("keep")
            Files.createSymbolicLink(File(root, "exports").toPath(), outside.toPath())
            assertEquals("LOCAL_STORAGE_FAILED", failure { FileBudget(root).capacity() })
            assertEquals("keep", File(outside, "keep").readText())
        } finally { root.deleteRecursively(); outside.deleteRecursively() }
    }
    private fun failure(block: () -> Unit) = (runCatching(block).exceptionOrNull() as? ProtocolFailure)?.code
}
