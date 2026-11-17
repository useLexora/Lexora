package app.uselexora.mobile

import app.uselexora.mobile.ui.MobileModelControls
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MobileModelControlsTest {
    private fun model(provider: String = "first") = JSONObject().put("providerId", provider).put("modelId", "shared-name")
        .put("displayName", "Same display name")
        .put("reasoningOptions", JSONArray(listOf("off", "medium", "high")))
        .put("serviceTiers", JSONArray().put(JSONObject().put("id", "priority")))

    @Test fun sameNameModelsRemainBoundToTheirProviderAndPreserveSupportedParameters() {
        val first = model()
        val second = model("second")
        val selected = MobileModelControls.parameters(second, "high", "priority")
        assertSame(second, MobileModelControls.model(selected, listOf(first, second)))
        assertEquals("second", selected.getString("providerId"))
        assertEquals("high", selected.getString("reasoning"))
        assertEquals("priority", selected.getString("serviceTier"))
        assertEquals(setOf("providerId", "modelId", "reasoning", "serviceTier"), selected.keys().asSequence().toSet())
    }

    @Test fun refreshedOrUnsupportedCapabilitiesNeverSubmitStaleParameters() {
        val model = model().put("reasoningOptions", JSONArray()).put("serviceTiers", JSONArray())
        val before = model.toString()
        val selected = MobileModelControls.parameters(model, "high", "priority")
        assertTrue(selected.isNull("reasoning"))
        assertTrue(selected.isNull("serviceTier"))
        assertFalse(MobileModelControls.supportsFast(selected, listOf(model)))
        assertEquals(before, model.toString())
    }

    @Test fun explicitOffAndDefaultTierAreNotReplacedWithInventedDefaults() {
        val model = model()
        val selection = MobileModelControls.parameters(model, "off", null)
        assertEquals("off", selection.getString("reasoning"))
        assertTrue(selection.isNull("serviceTier"))
        assertEquals("off", MobileModelControls.resolve(selection, listOf(model)).getString("reasoning"))
        assertEquals("medium", MobileModelControls.resolve(JSONObject().put("providerId", "first").put("modelId", "shared-name"), listOf(model)).getString("reasoning"))
        assertNull(MobileModelControls.model(selection, listOf(model("different-provider"))))
    }
}
