package app.uselexora.mobile

import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.ApprovalDocuments
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.SecretStore
import app.uselexora.mobile.ui.MainActivity
import app.uselexora.mobile.ui.TaskOperations
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class TaskOperationOwnershipInstrumentedTest {
    @Test fun confirmationFromAnotherComputerCannotCreateACommandEvenWhenTaskIdsMatch() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val executor = Executors.newSingleThreadExecutor()
        val errors = ConcurrentLinkedQueue<Throwable>()
        val secrets = SecretStore(context, "test-operation-owner-${UUID.randomUUID()}")
        Fixture(schemas).use { first -> Fixture(schemas).use { second -> LocalStore(context).use { store ->
            val firstPartition = first.client.identity!!.partition
            val secondPartition = second.client.identity!!.partition
            try {
                val selected = AtomicReference(first.client)
                ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use { scenario ->
                    lateinit var operations: TaskOperations
                    scenario.onActivity { activity ->
                        operations = TaskOperations(activity, store, { selected.get() }, ApprovalDocuments(MobileConnection(context, schemas, BuildConfig.VERSION_NAME, secrets)), schemas,
                            work = { action -> executor.execute { try { action() } catch (failure: Throwable) { errors.add(failure) } } },
                            ui = { action -> activity.runOnUiThread { action() } }, changed = {})
                        operations.readState(JSONObject().put("id", "shared-task").put("title", "共同任务 ID"))
                    }
                    MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists("此任务有未读结果") }
                    selected.set(second.client)
                    first.client.close()
                    MobileUiTestDriver.click("标为已读")
                    MobileUiTestDriver.waitUntil { !MobileUiTestDriver.exists("此任务有未读结果") }
                    executor.submit {}.get(5, TimeUnit.SECONDS)
                    assertTrue(errors.isEmpty())
                    assertTrue(first.intents.isEmpty())
                    assertTrue(second.intents.isEmpty())
                    assertTrue(store.outbox(firstPartition).isEmpty())
                    assertTrue(store.outbox(secondPartition).isEmpty())
                    scenario.onActivity { operations.readState(JSONObject().put("id", "shared-task").put("title", "当前服务任务")) }
                    MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists("此任务有未读结果") }
                    MobileUiTestDriver.click("标为已读")
                    MobileUiTestDriver.waitUntil { store.outbox(secondPartition).any { it.state == "accepted" } }
                    assertTrue(first.intents.isEmpty())
                    val intent = second.intents.single()
                    assertEquals("shared-task", intent.getString("conversationId"))
                    assertEquals("shared-run", intent.getString("resultRunId"))
                    assertTrue(intent.getBoolean("read"))
                    assertTrue(store.outbox(firstPartition).isEmpty())
                    assertEquals("taskMarks.setRead", store.outbox(secondPartition).single().method)
                    assertTrue(errors.isEmpty())
                    scenario.onActivity { operations.closeReview() }
                }
            } finally {
                executor.shutdown()
                assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS))
                store.writableDatabase.delete("outbox", "partition=? OR partition=?", arrayOf(firstPartition, secondPartition))
                secrets.clear()
            }
        } } }
    }
    private class Fixture(schemas: ProtocolSchemas) : AutoCloseable {
        val intents = ConcurrentLinkedQueue<JSONObject>()
        private val service = SyntheticProductService(schemas, listOf("taskMarks.states", "taskMarks.setRead")) { call ->
            when (call.method) {
                "taskMarks.states" -> call.reply(JSONArray().put(JSONObject().put("conversationId", "shared-task").put("markId", JSONObject.NULL)
                    .put("assignmentRevision", "0").put("resultRunId", "shared-run").put("readRevision", "0").put("unread", true)))
                "taskMarks.setRead" -> {
                    intents.add(call.params.getJSONObject("intent"))
                    val receipt = JSONObject().put("commandId", call.params.getString("commandId")).put("method", call.method)
                        .put("dataGeneration", call.params.getString("dataGeneration")).put("decidedAt", java.time.Instant.now().toString())
                        .put("decision", "accepted").put("target", JSONObject().put("conversationId", "shared-task")).put("result", JSONObject())
                    call.reply(JSONObject().put("receipt", receipt))
                }
                else -> error("Unexpected fixture method: ${call.method}")
            }
        }
        val client = try { service.connect() } catch (failure: Exception) {
            service.close()
            throw failure
        }
        override fun close() { client.close(); service.close() }
    }
}
