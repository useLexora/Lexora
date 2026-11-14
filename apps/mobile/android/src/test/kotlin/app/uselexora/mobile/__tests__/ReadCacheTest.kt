package app.uselexora.mobile

import app.uselexora.mobile.storage.ReadCache
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class ReadCacheTest {
    @Test fun publicDataSurvivesReopenButNeverCrossesDeviceOrBranch() {
        val directory = Files.createTempDirectory("reader-cache").toFile()
        try {
            val cache = ReadCache(directory)
            cache.write("service:profile:generation:device", "conversation:task:branch", listOf(JSONObject().put("id", "message").put("text", "中文😀")))
            val reopened = ReadCache(directory)
            assertEquals("中文😀", reopened.read("service:profile:generation:device", "conversation:task:branch")!!.single().getString("text"))
            assertNull(reopened.read("service:profile:other:device", "conversation:task:branch"))
            assertNull(reopened.read("service:profile:generation:other", "conversation:task:branch"))
            assertNull(reopened.read("service:profile:generation:device", "conversation:task:other"))
            directory.listFiles()!!.single().writeText("{interrupted")
            assertNull(reopened.read("service:profile:generation:device", "conversation:task:branch"))
        } finally { directory.deleteRecursively() }
    }
    @Test fun evictionAndInterruptedTemporaryFilesNeverExposePartialOrUnboundedData() {
        val directory = Files.createTempDirectory("reader-cache-budget").toFile()
        try {
            val cache = ReadCache(directory, 4096)
            for (index in 0..40) cache.write("owner", "task-$index", listOf(JSONObject().put("text", "x".repeat(256))))
            assertTrue(directory.listFiles()!!.sumOf { it.length() } <= 4096)
            assertTrue(directory.listFiles()!!.size <= 32)
            cache.write("owner", "models", listOf(JSONObject().put("id", "model")))
            cache.write("owner", "models", listOf(JSONObject().put("text", "x".repeat(8192))))
            assertEquals("model", cache.read("owner", "models")!!.single().getString("id"))
            directory.listFiles()!!.filter { it.extension == "json" }.forEach { it.setLastModified(1) }
            assertNull(cache.read("owner", "models"))
        } finally { directory.deleteRecursively() }
    }
}
