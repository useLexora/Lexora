package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import androidx.core.content.FileProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.network.MobileFiles
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.TransferStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import app.uselexora.mobile.preview.PreviewClient
import app.uselexora.mobile.preview.PreviewKind
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class LiveFilesInstrumentedTest {
    @Test fun uploadResumesFromCoreAndDownloadResumesTheSameVersion() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("livePairingFile") == "/data/local/tmp/lexora-pairing.json")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
        var client = connection.connect()!!
        LocalStore(context).use { store -> TransferStore(context).use { transfers ->
            val files = MobileFiles(context, transfers, store, connection)
            val owner = client.identity!!.partition
            val draftId = store.newId()
            val scope = "draft:$draftId"
            val snapshot = store.edit(owner, scope, JSONObject().put("content", MobileContentAdapter.textContent("保留正文与附件 😀")))
            val target = JSONObject().put("inputId", snapshot.value.getString("inputId"))
            val directory = File(context.filesDir, "exports").apply { mkdirs() }
            val source = File(directory, "验证-${UUID.randomUUID()}.txt")
            val bytes = "文件内容😀\n".repeat(50000).toByteArray(Charsets.UTF_8)
            source.writeBytes(bytes)
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", source)
            val transfer = files.stage(uri, owner, scope, JSONObject().put("kind", "task").put("draftId", draftId).put("spaceId", JSONObject.NULL))
            assertEquals(source.name, transfer.getJSONObject("file").getString("name"))
            assertEquals(MobileFiles.hash(bytes), transfer.getJSONObject("file").getString("sha256"))
            val created = CommandOutbox(store).submit(client, "uploads.stage", JSONObject(target.toString()).put("file", transfer.getJSONObject("file")), JSONObject().put("kind", "transfer").put("transferId", transfer.getString("id")).put("scope", scope))
            assertEquals("accepted", created.getString("decision"))
            val uploadId = created.getJSONObject("result").getString("uploadId")
            transfer.put("uploadId", uploadId).put("state", "receiving").put("confirmedBytes", 0)
            transfers.save(transfer)
            connection.http(client.identity!!) { transport, credential ->
                val chunk = bytes.copyOfRange(0, (MobileFiles.CHUNK_BYTES / 2))
                transport.request("/v1/uploads/$uploadId", "PUT", chunk, credential, mapOf("Content-Type" to "application/octet-stream", "Content-Range" to "bytes 0-${chunk.size - 1}/${bytes.size}", "X-Content-SHA256" to MobileFiles.hash(chunk))).use { assertTrue(it.isSuccessful) }
            }
            client.close()
            client = connection.connect()!!
            try {
                val adopted = files.upload(client, transfer, target)
                assertEquals("accepted", adopted.getString("decision"))
                val resourceId = adopted.getJSONObject("result").getString("resourceId")
                val repeated = files.upload(client, transfers.list(owner).first { it.optString("id") == transfer.getString("id") }, target)
                assertEquals(adopted.toString(), repeated.toString())
                val local = store.draft(owner, scope)!!
                assertEquals("保留正文与附件 😀", MobileContentAdapter.text(local.value.getJSONObject("content")))
                assertEquals(1, local.value.getJSONObject("content").getJSONArray("panelResourceIds").length())
                val remote = client.call("uploads.get", JSONObject().put("uploadId", uploadId))
                assertEquals("ready", remote.getString("state"))
                val publicResourceId = "attachment:${remote.getString("attachmentId")}"
                assertEquals(resourceId, remote.getString("resourceId"))
                val resource = client.call("resources.get", JSONObject().put("resourceId", publicResourceId))
                val prepared = client.call("resources.prepare", JSONObject().put("resourceId", publicResourceId).put("expectedVersion", resource.getString("revision")))
                val downloadId = store.newId()
                val partial = File(directory, "$downloadId.part")
                connection.http(client.identity!!) { transport, credential ->
                    transport.request("/v1/resources/${prepared.getString("downloadId")}", credential = credential, headers = mapOf("If-Match" to "\"${prepared.getString("contentVersion")}\"", "Range" to "bytes=0-${(MobileFiles.CHUNK_BYTES / 2) - 1}")).use { response ->
                        assertEquals(206, response.code)
                        RandomAccessFile(partial, "rw").use { it.write(response.body!!.bytes()); it.fd.sync() }
                    }
                }
                transfers.save(JSONObject().put("id", downloadId).put("partition", owner).put("kind", "download").put("resourceId", publicResourceId).put("contentVersion", prepared.getString("contentVersion")).put("confirmedBytes", (MobileFiles.CHUNK_BYTES / 2)).put("expectedVersion", resource.getString("revision")).put("prepared", prepared))
                prepared.put("expiresAt", "2000-01-01T00:00:00Z")
                val expired = transfers.list(owner).single { it.getString("id") == downloadId }.put("prepared", prepared)
                transfers.save(expired)
                val downloaded = files.download(client, resource)
                assertTrue(downloaded.name.startsWith("$downloadId-"))
                assertFalse(partial.exists())
                val refreshed = transfers.list(owner).single { it.getString("id") == downloadId }
                assertNotEquals("2000-01-01T00:00:00Z", refreshed.getJSONObject("prepared").getString("expiresAt"))
                assertEquals(bytes.size.toLong(), downloaded.length())
                assertEquals(MobileFiles.hash(bytes), MobileFiles.hash(downloaded))
                PreviewClient(context).use { renderer ->
                    val preview = renderer.render(downloaded, PreviewKind.TEXT)
                    assertNotEquals(android.os.Process.myUid(), preview.rendererUid)
                    assertTrue(preview.truncated)
                    assertTrue(preview.text!!.startsWith("文件内容😀\n"))
                }
                refreshed.getJSONObject("prepared").put("expiresAt", "2000-01-01T00:00:00Z")
                transfers.save(refreshed)
                assertEquals(downloaded, files.download(client, resource))
                assertEquals(1, transfers.list(owner).count { it.optString("kind") == "download" && it.optString("resourceId") == publicResourceId })
                val localFiles = app.uselexora.mobile.storage.LocalFiles(context, transfers, store)
                val cached = localFiles.list().single { it.record.getString("partition") == owner && it.file == downloaded.canonicalFile }
                localFiles.remove(cached.record)
                assertFalse(downloaded.exists())
                val downloadedAgain = files.download(client, resource)
                assertEquals(prepared.getString("contentVersion"), MobileFiles.hash(downloadedAgain))
                assertEquals(publicResourceId, client.call("resources.get", JSONObject().put("resourceId", publicResourceId)).getString("resourceId"))
                val emptyId = store.newId()
                val emptyScope = "draft:$emptyId"
                val empty = store.edit(owner, emptyScope, JSONObject().put("content", MobileContentAdapter.textContent("")))
                val emptyTarget = JSONObject().put("inputId", empty.value.getString("inputId"))
                files.upload(client, files.stage(uri, owner, emptyScope, JSONObject().put("kind", "task").put("draftId", emptyId).put("spaceId", JSONObject.NULL)), emptyTarget)
                assertEquals(1, store.draft(owner, emptyScope)!!.value.getJSONObject("content").getJSONArray("panelResourceIds").length())
                val cancelling = files.stage(uri, owner, scope, JSONObject().put("kind", "task").put("draftId", draftId).put("spaceId", JSONObject.NULL))
                files.cancel(client, cancelling)
                assertFalse(File(cancelling.getString("path")).exists())
                assertEquals("cancelled", transfers.list(owner).first { it.getString("id") == cancelling.getString("id") }.getString("state"))
            } finally { client.close(); source.delete() }
        } }
    }
}
