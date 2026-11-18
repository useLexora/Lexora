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
    @Test fun oversizedConversationRetainsNewestWholeMessagesWithinUtf8Budget() {
        val directory = Files.createTempDirectory("recent-messages").toFile()
        try {
            val cache = ReadCache(directory, 650)
            val key = "conversation:task:branch"
            fun message(index: Int) = JSONObject().put("entity", "message").put("value", JSONObject()
                .put("id", "m$index").put("createdAt", "2026-11-18T00:00:0${index}Z").put("text", "好".repeat(48)))
            cache.write("device", key, listOf(message(3), message(1), message(2)))
            assertEquals(listOf("m2", "m3"), cache.read("device", key)!!.map { it.getJSONObject("value").getString("id") })
            assertTrue(directory.listFiles()!!.single().length() <= 650)
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
