package app.uselexora.mobile.ui

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ReaderToolImageIdTest {
    private fun event(presentation: JSONObject, tool: String = "tool", type: String = "tool.completed") = JSONObject()
        .put("runId", "run").put("type", type).put("payload", JSONObject().put("toolCallId", tool).put("presentation", presentation))
    private fun presentation(output: String = "output", input: String = "input") = JSONObject().put("card", "image")
        .put("artifactIds", JSONArray(listOf(output))).put("reference", JSONObject().put("mode", "resources").put("resourceIds", JSONArray(listOf(input))))
    private fun transcript(vararg events: JSONObject) = mapOf("run" to JSONObject().put("events", JSONArray(events.toList())))

    @Test fun onlyResourcesDeclaredByTheSameToolAndRunCanBeRead() {
        val source = transcript(event(presentation()))
        val output = ReaderToolImageId("run", "tool", "artifact", "output")
        assertEquals(listOf("artifact:output"), output.resources(source))
        assertEquals(listOf("attachment:input", "artifact:input"), output.copy(kind = "reference", id = "input").resources(source))
        for (unknown in listOf(output.copy(runId = "another"), output.copy(toolCallId = "another"), output.copy(id = "input"), output.copy(kind = "reference"), output.copy(id = "artifact:output"))) {
            assertTrue(unknown.resources(source).isEmpty())
        }
    }
    @Test fun newerPresentationsAndDenialsInvalidatePreviousImageAccess() {
        val id = ReaderToolImageId("run", "tool", "artifact", "output")
        assertTrue(id.resources(transcript(event(presentation()), event(presentation("replacement")))).isEmpty())
        assertTrue(id.resources(transcript(event(presentation()), event(JSONObject(), type = "tool.denied"))).isEmpty())
        assertTrue(id.resources(transcript(event(presentation()), event(JSONObject().put("card", "terminal")))).isEmpty())
        val latest = presentation().put("reference", JSONObject().put("mode", "latest"))
        assertTrue(id.copy(kind = "reference", id = "input").resources(transcript(event(latest))).isEmpty())
    }
}
