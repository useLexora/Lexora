package app.uselexora.mobile

import android.content.Intent
import android.net.Uri
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.protocol.MobileContentAdapter
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.MaterialDrafts
import app.uselexora.mobile.ui.IncomingMaterial
import app.uselexora.mobile.ui.MainActivity
import app.uselexora.mobile.ui.MobileAppearance
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class MaterialFlowInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    @Test fun sharesRejectPrivateSourcesAndKeepMultipleDocuments() {
        val uri = Uri.parse("content://app.uselexora.mobile.dev.test.file-workflow/source")
        val parsed = IncomingMaterial.read(Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(uri, uri)).putExtra(Intent.EXTRA_TEXT, "材料说明"), context.packageName)!!
        assertEquals(listOf(uri), parsed.uris)
        assertEquals(parsed, IncomingMaterial.restore(parsed.json()))
        for (blocked in listOf("file:///data/private", "content://${context.packageName}.files/exports/private")) assertTrue(runCatching { IncomingMaterial.read(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, Uri.parse(blocked)), context.packageName) }.isFailure)
        assertTrue(runCatching { IncomingMaterial.read(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_TEXT, "x".repeat(65537)), context.packageName) }.isFailure)
    }
    @Test fun materialRetryPreservesInputIdentityAttachmentsAndNewerEdits() {
        val owner = "material-${UUID.randomUUID()}"
        val target = "draft:${UUID.randomUUID()}"
        val id = UUID.randomUUID().toString()
        var inputId = ""
        LocalStore(context).use { store ->
            val value = JSONObject().put("content", MobileContentAdapter.textContent("原有输入").put("panelResourceIds", JSONArray(listOf("resource-original")))).put("modelSelection", JSONObject().put("modelId", "test-model"))
            inputId = store.edit(owner, target, value).value.getString("inputId")
            val applied = MaterialDrafts.append(store, owner, target, id, "分享材料")
            assertEquals("原有输入\n\n分享材料", MobileContentAdapter.text(applied.value.getJSONObject("content")))
            applied.value.getJSONObject("content").getJSONArray("body").getJSONObject(0).getJSONArray("content").getJSONObject(0).put("text", "用户后续编辑")
            store.edit(owner, target, applied.value)
        }
        LocalStore(context).use { store ->
            val result = MaterialDrafts.append(store, owner, target, id, "分享材料")
            assertEquals("用户后续编辑", MobileContentAdapter.text(result.value.getJSONObject("content")))
            assertEquals(inputId, result.value.getString("inputId"))
            assertEquals("resource-original", result.value.getJSONObject("content").getJSONArray("panelResourceIds").getString(0))
            assertEquals("test-model", result.value.getJSONObject("modelSelection").getString("modelId"))
            assertTrue(store.outbox(owner).isEmpty())
            store.writableDatabase.delete("drafts", "partition=?", arrayOf(owner))
        }
    }
    @Test fun externalTextSurvivesRecreationAndOnlyEntersTheChosenDraft() {
        val originalLanguage = MobileAppearance.language
        InstrumentationRegistry.getInstrumentation().runOnMainSync { MobileAppearance.selectLanguage(context, "en") }
        val text = "Share acceptance ${UUID.randomUUID()}"
        try { ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text).putExtra("fixture", true)).use { scenario ->
            MobileUiTestDriver.waitUntil { MobileUiTestDriver.contains("Add to a task") }
            scenario.recreate()
            MobileUiTestDriver.waitUntil { MobileUiTestDriver.contains("Add to a task") }
            MobileUiTestDriver.click("New task")
            var input = ""
            MobileUiTestDriver.waitUntil { scenario.onActivity { input = it.findViewById<EditText>(MainActivity.INPUT_ID).text.toString() }; input == text }
            scenario.recreate()
            MobileUiTestDriver.waitUntil { scenario.onActivity { input = it.findViewById<EditText>(MainActivity.INPUT_ID).text.toString() }; input == text }
            LocalStore(context).use { store ->
                val drafts = store.drafts().filter { MobileContentAdapter.text(it.value.getJSONObject("content")) == text }
                assertEquals(1, drafts.size)
                assertTrue(store.outbox(drafts.single().partition).none { it.envelope.toString().contains(text) })
            }
        } } finally { InstrumentationRegistry.getInstrumentation().runOnMainSync { MobileAppearance.selectLanguage(context, originalLanguage) } }
    }
    @Test fun sharedFileRetryKeepsOneCopyAndOriginalInputOwnership() {
        val owner = "share-file-${UUID.randomUUID()}"
        val target = "draft:${UUID.randomUUID()}"
        val material = UUID.randomUUID().toString()
        LocalStore(context).use { store -> app.uselexora.mobile.storage.TransferStore(context).use { transfers ->
            val schemas = app.uselexora.mobile.protocol.ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
            val files = app.uselexora.mobile.network.MobileFiles(context, transfers, store, app.uselexora.mobile.network.MobileConnection(context, schemas, BuildConfig.VERSION_NAME))
            val draft = MaterialDrafts.append(store, owner, target, material, "说明")
            val inputId = draft.value.getString("inputId")
            val uri = Uri.parse("content://app.uselexora.mobile.dev.test.file-workflow/source")
            val first = files.stageMaterial(uri, owner, target, material, inputId)
            try {
                val later = files.stageMaterial(uri, owner, target, material, inputId)
                assertEquals(first.getString("id"), later.getString("id"))
                assertEquals(1, transfers.list(owner).size)
                assertEquals(inputId, later.getString("inputId"))
                assertEquals("原附件😀", java.io.File(later.getString("path")).readText())
                assertTrue(store.outbox(owner).isEmpty())
            } finally { java.io.File(first.getString("path")).delete(); transfers.writableDatabase.delete("transfers", "partition=?", arrayOf(owner)); store.writableDatabase.delete("drafts", "partition=?", arrayOf(owner)) }
        } }
    }
}
