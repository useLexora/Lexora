package app.uselexora.mobile

import app.uselexora.mobile.ui.MobileQueueControls
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MobileQueueControlsTest {
    private fun item(state: String = "paused", revision: String = "7") = JSONObject().put("id", "input")
        .put("conversationId", "task").put("branchId", "branch").put("revision", revision).put("state", state)
        .put("steerTarget", JSONObject().put("runId", "legacy-target").put("generation", "1"))
    private fun control(revision: String = "7") = JSONObject().put("id", "input").put("revision", revision)
        .put("allowedActions", JSONArray(listOf("cancel", "continue", "steer")))
        .put("steerTarget", JSONObject().put("runId", "public-target").put("generation", "9"))
        .put("delivery", JSONObject.NULL).put("blockedReason", JSONObject.NULL)

    @Test fun onlyExactItemRevisionAuthorizesNewCoreActions() {
        assertEquals(listOf("cancel", "continue", "steer"), MobileQueueControls.actions(item(), control(), true))
        assertTrue(MobileQueueControls.actions(item(), control("8"), true).isEmpty())
        assertTrue(MobileQueueControls.actions(item(), control().put("id", "another"), true).isEmpty())
        assertTrue(MobileQueueControls.actions(item(), null, true).isEmpty())
        assertTrue(MobileQueueControls.actions(item("sent"), control(), true).isEmpty())
        assertEquals(listOf("cancel"), MobileQueueControls.actions(item(), control().put("allowedActions", JSONArray(listOf("cancel"))), true))
    }

    @Test fun oldCoreNeverInfersContinueOrSteerFromPausedOrLegacyTarget() {
        assertEquals(listOf("cancel"), MobileQueueControls.actions(item(), null, false))
        assertEquals(listOf("cancel"), MobileQueueControls.actions(item("waiting"), null, false))
        assertTrue(MobileQueueControls.actions(item("cancelled"), null, false).isEmpty())
    }

    @Test fun lostFixedCurrentTargetCannotBecomeAnotherRun() {
        val value = control().put("blockedReason", "target_unavailable").put("delivery", JSONObject().put("mode", "current")
            .put("actorId", "actor").put("target", JSONObject().put("rootRunId", "root").put("runId", "lost")))
        assertEquals(listOf("cancel"), MobileQueueControls.actions(item(), value, true))
        value.getJSONObject("delivery").put("target", JSONObject.NULL)
        value.put("blockedReason", JSONObject.NULL).put("allowedActions", JSONArray(listOf("cancel", "continue")))
        assertEquals(listOf("cancel", "continue"), MobileQueueControls.actions(item(), value, true))
    }

    @Test fun steerUsesOnlyPublicControlsAndRetainsQueueCasAndExactRunGeneration() {
        val original = control()
        val intent = MobileQueueControls.intent(item(), original, "steer")
        assertEquals("input", intent.getString("id"))
        assertEquals("7", intent.getString("expectedRevision"))
        assertEquals("public-target", intent.getString("targetRunId"))
        assertEquals("9", intent.getString("expectedRunGeneration"))
        assertTrue(MobileQueueControls.sameSteerTarget(original, control()))
        assertFalse(MobileQueueControls.sameSteerTarget(original, control().put("steerTarget", JSONObject().put("runId", "public-target").put("generation", "10"))))
        assertFalse(MobileQueueControls.sameSteerTarget(original, null))
        assertEquals(listOf("cancel", "continue"), MobileQueueControls.actions(item(), control().put("steerTarget", JSONObject.NULL), true))
    }

    @Test fun attachmentOnlyAndMixedContentCountEachResourceOnce() {
        val content = JSONObject().put("version", 1).put("panelResourceIds", JSONArray(listOf("file-a", "file-b")))
            .put("body", JSONArray().put(JSONObject().put("type", "paragraph").put("content", JSONArray()
                .put(JSONObject().put("type", "resource_ref").put("resourceId", "file-a"))
                .put(JSONObject().put("type", "resource_ref").put("resourceId", "file-c")))))
        val value = item().put("content", JSONObject().put("kind", "editable").put("content", content))
        assertEquals(3, MobileQueueControls.attachmentCount(value))
        content.getJSONArray("body").getJSONObject(0).getJSONArray("content").put(JSONObject().put("type", "text").put("text", "Keep the description"))
        assertEquals(3, MobileQueueControls.attachmentCount(value))
        assertEquals(0, MobileQueueControls.attachmentCount(item().put("content", JSONObject().put("kind", "unsupported").put("summary", "Unknown materials"))))
    }
}
