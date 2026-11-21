package app.uselexora.mobile

import app.uselexora.mobile.protocol.ProductIdentity
import app.uselexora.mobile.protocol.ProductResumePoint
import app.uselexora.mobile.protocol.SubscriptionProjection
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SubscriptionProjectionTest {
    private val identity = ProductIdentity("service", "profile", "data", "device", "instance")
    private val topic = "conversation:t:b"
    private val wire = "conversationTurns:t:b"
    private fun position(seq: String) = JSONObject().put("syncEpoch", "epoch").put("seq", seq)
    private fun message(text: String) = JSONObject().put("entity", "message").put("value", JSONObject().put("id", "a").put("body", JSONObject().put("text", text)))
    private var time = 5L
    private var serial = 0L
    private fun model(id: ProductIdentity = identity) = SubscriptionProjection(id, { ++serial }, { _, _, _ -> }, { time })
    private fun point(): ProductResumePoint = model().run {
        snapshot(topic, listOf(message("first")))
        commit(topic, wire, position("7"))
        checkpoint!!
    }

    @Test fun replayAdvancesCheckpointWithTheSameBaselineWhileSnapshotReplacesIt() {
        val original = point()
        val next = model().apply { inherit(original) }
        val resume = next.takeBase(topic, wire)!!
        assertTrue(resume.matches(position("7")))
        assertFalse(resume.matches(position("8")))
        assertFalse(resume.matches(position("7").put("syncEpoch", "another-epoch")))
        next.restore(resume)
        next.apply(topic, listOf(JSONObject().put("kind", "upsert").put("item", message("later"))))
        next.commit(topic, wire, position("8"))

        fun text(point: ProductResumePoint) = point.items.single().getJSONObject("value").getJSONObject("body").getString("text")
        val replayed = next.checkpoint!!
        assertTrue(replayed.matches(position("8")))
        assertEquals("later", text(replayed))
        assertEquals(original.serial, replayed.serial)
        assertEquals("first", text(original))

        next.snapshot(topic, listOf(message("fresh")))
        next.commit(topic, wire, position("99").put("syncEpoch", "new-epoch"))
        val replaced = next.checkpoint!!
        assertTrue(replaced.matches(position("99").put("syncEpoch", "new-epoch")))
        assertEquals("fresh", text(replaced))
        assertNotEquals(original.serial, replaced.serial)
    }

    @Test fun onlySameShortLivedIdentityScopeAndWireCanSupplyTheFirstBase() {
        val seed = point()
        for (other in listOf(identity.copy(serviceId = "other"), identity.copy(profileId = "other"), identity.copy(dataGeneration = "other"), identity.copy(deviceId = "other"), identity.copy(serviceInstanceId = "other"))) {
            assertNull(model(other).apply { inherit(seed) }.takeBase(topic, wire))
        }
        val switched = model().apply { inherit(seed) }
        assertNull(switched.takeBase("conversation:t:fork", "conversationTurns:t:fork"))
        assertNull(switched.takeBase(topic, wire))
        assertNull(model().apply { inherit(seed) }.takeBase(topic, "conversationWindow:t:b"))
        val unused = model().apply { inherit(seed) }
        time += 121_000_000_000L
        assertNull(unused.takeBase(topic, wire))
        val legacy = model()
        legacy.snapshot(topic, listOf(message("old")))
        legacy.commit(topic, "conversationWindow:t:b", position("7"))
        assertNull(legacy.checkpoint)
    }
}
