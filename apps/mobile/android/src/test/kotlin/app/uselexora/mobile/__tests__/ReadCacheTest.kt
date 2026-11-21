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
            val retained = cache.read("device", key)!!.map { it.getJSONObject("value") }
            assertEquals(listOf("m2", "m3"), retained.map { it.getString("id") })
            assertTrue(retained.all { it.getString("text") == "好".repeat(48) })
            assertTrue(directory.listFiles()!!.single().length() <= 650)
        } finally { directory.deleteRecursively() }
    }

    @Test fun oversizedCompactWindowDoesNotSplitPreviouslyCachedConversation() {
        val directory = Files.createTempDirectory("turn-cache").toFile()
        try {
            val cache = ReadCache(directory, 512)
            val key = "conversation:task:branch"
            fun item(kind: String, id: String) = JSONObject().put("entity", kind).put("value", JSONObject().put("id", id))
            val history = JSONObject("""{"entity":"historyWindow","value":{"conversationId":"task","branchId":"branch","nextCursor":"older","hasMore":true}}""")
            val folded = listOf(item("message", "question"), item("activityGroup", "summary"), item("message", "answer"), history)
            cache.write("owner", key, folded)

            val latest = item("message", "new")
            latest.getJSONObject("value").put("body", JSONObject().put("kind", "text").put("text", "X".repeat(1024)))
            cache.write("owner", key, folded + latest)
            val retained = cache.read("owner", key)!!
            assertEquals(folded.size, retained.size)
            assertEquals(folded.map { it.toString() }, retained.map { it.toString() })
        } finally { directory.deleteRecursively() }
    }

    @Test fun evictionKeepsTheLatestEntryWithinIndependentByteAndEntryBudgets() {
        val directory = Files.createTempDirectory("reader-cache-budget").toFile()
        try {
            val item = JSONObject().put("text", "x".repeat(256))
            for (budget in listOf(4096L, 65536L)) {
                val target = directory.resolve("budget-$budget")
                val cache = ReadCache(target, budget)
                for (index in 0..32) cache.write("owner", "task-$index", listOf(item))
                val files = target.listFiles()!!
                assertTrue(files.sumOf { it.length() } <= budget)
                if (budget == 65536L) assertEquals(32, files.size)
                assertEquals(item.getString("text"), cache.read("owner", "task-32")!!.single().getString("text"))
            }
        } finally { directory.deleteRecursively() }
    }

    @Test fun oversizedWriteKeepsTheLastEntryUntilItExpires() {
        val directory = Files.createTempDirectory("reader-cache-expiry").toFile()
        try {
            val cache = ReadCache(directory, 4096)
            cache.write("owner", "models", listOf(JSONObject().put("id", "model")))
            cache.write("owner", "models", listOf(JSONObject().put("text", "x".repeat(8192))))
            assertEquals("model", cache.read("owner", "models")!!.single().getString("id"))
            assertTrue(directory.listFiles()!!.single().setLastModified(1L))
            assertNull(cache.read("owner", "models"))
        } finally { directory.deleteRecursively() }
    }
}
