package app.uselexora.mobile.ui

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ConversationReadingWindowTest {
    private fun row(id: String) = JSONObject().put("id", id)
    private fun page(cursor: String?, vararg ids: String) = ConversationPage(messages = ids.map(::row), next = cursor)
    private fun ids(rows: List<JSONObject>) = rows.map { it.getString("id") }

    @Test fun replayKeepsThePagedViewButNewSnapshotsRejectOldRequestsEvenWhenTheCursorMatches() {
        val reading = ConversationReadingWindow()
        reading.project(1, page("recent", "m5", "m6"))
        val older = page("older", "m3", "m4").copy(groups = listOf(row("group")), runs = listOf(row("run-without-reply")))
        assertTrue(reading.append(reading.request()!!, older))
        val inFlight = reading.request()!!

        reading.disconnected()
        assertFalse(reading.project(1, page("recent", "m5", "m6", "m7")))
        assertEquals(inFlight, reading.request())
        val pagedMessages = listOf("m3", "m4", "m5", "m6", "m7")
        assertEquals(pagedMessages, ids(reading.display.messages))
        assertEquals(listOf("run-without-reply"), ids(reading.display.runs))
        assertTrue(reading.latest.runs.isEmpty())

        assertTrue(reading.project(2, page("new-recent", "n6")))
        reading.project(3, page("new-recent", "n6", "n7"))
        assertEquals(ConversationReadingWindow.Mode.Detached, reading.mode)
        assertEquals(pagedMessages, ids(reading.display.messages))
        assertEquals(listOf("group"), ids(reading.display.groups))
        assertNull(reading.request())

        reading.resume()
        assertEquals(listOf("n6", "n7"), ids(reading.display.messages))
        assertTrue(reading.display.groups.isEmpty())
        assertTrue(reading.display.runs.isEmpty())
        assertEquals("new-recent", reading.request()!!.cursor)
        assertTrue(reading.append(reading.request()!!, page(inFlight.cursor, "n4", "n5")))
        val fresh = reading.request()!!
        assertEquals(inFlight.cursor, fresh.cursor)
        assertEquals(inFlight.mode, fresh.mode)
        assertFalse(reading.append(inFlight, page(null, "obsolete")))
        assertEquals(listOf("n4", "n5", "n6", "n7"), ids(reading.display.messages))
    }

    @Test fun initialSearchWindowStaysIndependentAndResyncWithoutPagingUsesFreshWindowDirectly() {
        val reading = ConversationReadingWindow()
        reading.pin(page("search:back", "found"))
        reading.project(1, page("recent:back", "unrelated-tail"))
        assertEquals("search:back", reading.request()!!.cursor)
        assertTrue(reading.append(reading.request()!!, page("search:next", "earlier")))
        reading.disconnected()
        reading.project(1, page("recent:back", "resumed-tail"))
        assertEquals("search:next", reading.request()!!.cursor)

        reading.project(2, page("new:back", "new-tail"))
        assertEquals(listOf("earlier", "found"), ids(reading.display.messages))
        assertNull(reading.request())

        reading.resume()
        reading.project(3, page(null, "all-that-remains"))
        assertEquals(listOf("all-that-remains"), ids(reading.display.messages))
        assertNull(reading.request())
    }
}
