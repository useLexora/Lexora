package app.uselexora.mobile.ui

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.network.*
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.session.MobileOperationFailure
import app.uselexora.mobile.session.MobileOperationOwner
import app.uselexora.mobile.storage.SavedDownloadFiles
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

internal class DownloadActions(
    private val activity: ComponentActivity, private val ui: MobileUiState,
    private val connection: MobileConnection, private val copies: TaskFileCopies, private val saved: SavedDownloadFiles,
    private val owner: () -> MobileOperationOwner, private val notice: (String) -> Unit, restored: Bundle?,
) : AutoCloseable {
    private val executor = Executors.newSingleThreadExecutor()
    private val fileIO = Executors.newSingleThreadExecutor()
    private val engine by lazy { Downloads.get(activity.applicationContext) }
    private var listener: AutoCloseable? = null
    @Volatile private var partition: String? = null
    @Volatile private var closed = false
    private var folder = restored?.getString("downloadFolderRequest")?.let(::JSONObject)
    private var export = restored?.getString("downloadExportRequest")?.let(::JSONObject)
    private val chooseFolder = activity.registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        val request = folder; folder = null
        if (uri != null && request != null && request.getString("owner") == partition) start(request.getJSONObject("resource"), uri)
    }
    private val chooseDocument = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val request = export; export = null
        val uri = result.data?.data
        if (result.resultCode == Activity.RESULT_OK && uri != null && request != null && request.getString("owner") == partition) {
            val target = owner()
            run(target, fileWork = true) {
                val record = engine.records(target.partition).firstOrNull { it.id == request.getString("id") } ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
                saved.export(record, uri)
                onCurrent(target) { notice(mobileText(R.string.file_saved)) }
            }
        }
    }
    fun saveState(out: Bundle) {
        out.putString("downloadFolderRequest", folder?.toString()); out.putString("downloadExportRequest", export?.toString())
    }
    fun bind(next: String) {
        if (partition == next) return
        partition = next; ui.downloadRecords = null; ui.resourceMenu = null
        executor.execute {
            listener?.close(); listener = null
            if (!closed && partition == next) try {
                listener = engine.listen(next) { records -> if (!closed && partition == next) ui.downloadRecords = records }
            } catch (error: Exception) { activity.runOnUiThread { if (!closed && partition == next) notice(MobileFailurePresentation.message(MobileOperationFailure.from(error))) } }
        }
    }
    private fun onCurrent(target: MobileOperationOwner, action: () -> Unit) = activity.runOnUiThread {
        if (!closed && owner() == target) action()
    }
    private fun run(target: MobileOperationOwner, fileWork: Boolean = false, operation: () -> Unit) {
        (if (fileWork) fileIO else executor).execute {
            try { if (!closed && partition == target.partition) operation() }
            catch (error: Exception) { onCurrent(target) { notice(MobileFailurePresentation.message(MobileOperationFailure.from(error))) } }
        }
    }
    fun download(resource: JSONObject, choose: Boolean) {
        if (choose || Build.VERSION.SDK_INT < 29) {
            folder = JSONObject().put("owner", owner().partition).put("resource", resource)
            try { chooseFolder.launch(null) } catch (_: android.content.ActivityNotFoundException) { folder = null; notice(mobileText(R.string.error_document_save_failed)) }
        } else start(resource, null)
    }
    private fun start(resource: JSONObject, tree: Uri?) {
        val target = owner()
        run(target, fileWork = true) {
            if (resource.optString("resourceId").startsWith("attachment:") || resource.has("localInputId")) copies.forAction(target.partition, resource)
            engine.start(target.partition, resource, target.connection, connection, tree)
        }
    }
    fun completedFor(resource: JSONObject) = ui.downloadRecords?.firstOrNull { it.partition == partition && it.resourceId == resource.optString("resourceId") && it.revision == resource.optString("revision") && it.state == DownloadState.COMPLETED }
    fun preview(record: DownloadRecord): File = saved.preview(record)
    fun select(action: DownloadUiAction, id: String) {
        val target = owner()
        val record = ui.downloadRecords?.firstOrNull { it.partition == target.partition && it.id == id } ?: return
        when (action) {
            DownloadUiAction.Pause -> run(target) { engine.pause(target.partition, id) }
            DownloadUiAction.Resume -> run(target) { engine.resume(target.partition, id, target.connection, connection) }
            DownloadUiAction.Cancel -> run(target) { engine.cancel(target.partition, id) }
            DownloadUiAction.Open -> use(record, R.string.open_other_app)
        }
    }
    fun use(record: DownloadRecord, action: Int) {
        val target = owner()
        if (record.partition != target.partition || record.state != DownloadState.COMPLETED) return
        if (action == R.string.save_to_files) {
            export = JSONObject().put("owner", record.partition).put("id", record.id)
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(record.mimeType).putExtra(Intent.EXTRA_TITLE, record.name)
            try { chooseDocument.launch(intent) } catch (_: android.content.ActivityNotFoundException) { export = null; notice(mobileText(R.string.error_document_save_failed)) }
            return
        }
        run(target, fileWork = true) {
            val uri = saved.verify(record)
            val mime = activity.contentResolver.downloadedMime(uri, record.name, record.mimeType)
            onCurrent(target) {
                val sharing = action == R.string.share_file_title
                try {
                    val intent = if (sharing) Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                        else Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                    intent.clipData = ClipData.newRawUri(record.name, uri)
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    activity.startActivity(if (sharing) Intent.createChooser(intent, mobileText(action)) else intent)
                }
                catch (_: android.content.ActivityNotFoundException) { notice(mobileText(R.string.mobile_no_compatible_app_available_save_to_a_file_instead)) }
                catch (_: SecurityException) { notice(mobileText(R.string.mobile_could_not_grant_another_app_read_access_the_phone)) }
            }
        }
    }
    override fun close() { closed = true; executor.execute { listener?.close(); listener = null }; executor.shutdown(); fileIO.shutdown() }
}
