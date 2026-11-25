package app.uselexora.mobile.network

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.storage.LocalFiles
import app.uselexora.mobile.storage.TransferStore
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

class Downloads internal constructor(private val context: Context) {
    private val journal = DownloadJournal(context)
    private val cache = TransferStore(context)
    private val output = DownloadDestination(context)
    private val worker = Executors.newSingleThreadExecutor { Thread(it, "lexora-user-downloads") }
    private val main = Handler(Looper.getMainLooper())
    private val rows = linkedMapOf<String, DownloadEntry>()
    private val active = mutableMapOf<String, Ticket>()
    private val observers = mutableSetOf<Observer>()

    private class Ticket(val id: String) {
        @Volatile var stopped = false
        @Volatile var transport: PinnedTransport? = null
        fun check() { if (stopped) throw ProtocolFailure("DOWNLOAD_STOPPED") }
        fun stop() { stopped = true; transport?.close() }
    }
    private class Observer(val partition: String, val listener: (List<DownloadRecord>) -> Unit) {
        val latest = java.util.concurrent.atomic.AtomicReference<List<DownloadRecord>?>(null)
        @Volatile var closed = false
    }
    init {
        for (stored in journal.load()) {
            val row = if (stored.record.state in ongoing) stored.copy(record = stored.record.copy(state = DownloadState.INTERRUPTED, error = "DOWNLOAD_INTERRUPTED")) else stored
            if (row != stored) journal.save(row)
            rows[row.record.id] = row
        }
        rows.values.filter { it.deleting }.forEach { scheduleDelete(it.record.id) }
    }
    companion object {
        @Volatile private var singleton: Downloads? = null
        private val ongoing = setOf(DownloadState.QUEUED, DownloadState.RUNNING, DownloadState.VERIFYING)
        fun get(context: Context): Downloads = singleton ?: synchronized(this) {
            singleton ?: Downloads(context.applicationContext).also { singleton = it }
        }
    }
    @Synchronized fun records(partition: String): List<DownloadRecord> = rows.values.asSequence().map { it.record }
        .filter { it.partition == partition }.toList().asReversed()
    @Synchronized fun listen(partition: String, listener: (List<DownloadRecord>) -> Unit): AutoCloseable {
        val observer = Observer(partition, listener)
        observers.add(observer); notify(observer)
        return AutoCloseable { observer.closed = true; synchronized(this) { observers.remove(observer) } }
    }
    private fun notify(observer: Observer) {
        if (observer.closed || observer.latest.getAndSet(records(observer.partition)) != null) return
        main.post {
            val snapshot = observer.latest.getAndSet(null)
            if (!observer.closed && snapshot != null) observer.listener(snapshot)
        }
    }
    private fun save(row: DownloadEntry) {
        journal.save(row); rows[row.record.id] = row
        observers.filter { it.partition == row.record.partition }.forEach(::notify)
    }
    private fun owned(partition: String, id: String): DownloadEntry = rows[id]?.takeIf { it.record.partition == partition } ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
    private fun validateClient(partition: String, client: ProductClient?) {
        if (client != null && client.identity?.partition != partition) throw ProtocolFailure("DATA_GENERATION_CHANGED")
    }
    @Synchronized fun start(partition: String, resource: JSONObject, client: ProductClient?, connection: MobileConnection, tree: Uri? = null): String {
        validateClient(partition, client)
        require(partition.isNotBlank())
        val resourceId = resource.getString("resourceId"); val revision = resource.getString("revision")
        rows.values.lastOrNull { it.record.partition == partition && it.record.resourceId == resourceId && it.record.revision == revision && it.tree == tree &&
            it.record.state !in setOf(DownloadState.CANCELLED, DownloadState.COMPLETED) && !it.deleting }?.let {
            resume(partition, it.record.id, client, connection); return it.record.id
        }
        output.grant(tree)
        val id = UUID.randomUUID().toString()
        val record = DownloadRecord(id, partition, resourceId, revision, LocalFiles.downloadName(resource.optString("name", "download")),
            resource.optString("mimeType", "application/octet-stream"), DownloadState.QUEUED, 0, null, null, null, null, customFolder = tree != null)
        queue(DownloadEntry(record, tree), client, connection)
        return id
    }
    @Synchronized fun resume(partition: String, id: String, client: ProductClient?, connection: MobileConnection) {
        val row = owned(partition, id); validateClient(partition, client)
        if (row.deleting || row.record.state in ongoing || row.record.state in setOf(DownloadState.COMPLETED, DownloadState.CANCELLED)) return
        queue(row.copy(record = row.record.copy(state = DownloadState.QUEUED, error = null)), client, connection)
    }
    private fun queue(entry: DownloadEntry, client: ProductClient?, connection: MobileConnection) {
        save(entry)
        val ticket = Ticket(entry.record.id); active[ticket.id] = ticket
        worker.execute {
            try { transfer(ticket, client, connection) }
            catch (error: Exception) {
                synchronized(this) {
                    if (active[ticket.id] === ticket) {
                        val row = rows.getValue(ticket.id)
                        val failure = generateSequence<Throwable>(error) { it.cause }.filterIsInstance<ProtocolFailure>().firstOrNull()?.code
                        val code = failure ?: if (error is SecurityException) "LOCAL_STORAGE_FAILED" else "DOWNLOAD_INTERRUPTED"
                        val state = if (code in setOf("DOWNLOAD_INTERRUPTED", "SERVICE_UNREACHABLE", "NOT_CONNECTED", "CONNECTION_CLOSED", "TIMEOUT")) DownloadState.INTERRUPTED else DownloadState.FAILED
                        save(row.copy(record = row.record.copy(state = state, error = code)))
                    }
                }
            } finally { synchronized(this) { if (active[ticket.id] === ticket) active.remove(ticket.id) } }
        }
    }
    @Synchronized fun pause(partition: String, id: String) {
        val row = owned(partition, id)
        if (row.deleting || row.record.state !in ongoing || row.publishing != null) return
        save(row.copy(record = row.record.copy(state = DownloadState.PAUSED, error = null)))
        active.remove(id)?.stop()
    }
    @Synchronized fun cancel(partition: String, id: String) {
        val row = owned(partition, id)
        if (row.record.state == DownloadState.COMPLETED || row.record.state == DownloadState.CANCELLED || (row.publishing != null && row.record.state in ongoing)) return
        save(row.copy(deleting = true, record = row.record.copy(state = DownloadState.PAUSED, error = null)))
        active.remove(id)?.stop(); scheduleDelete(id)
    }
    private fun scheduleDelete(id: String) = worker.execute {
        val row = synchronized(this) { rows.getValue(id).takeIf { it.deleting } } ?: return@execute
        try {
            val published = output.published(row)
            if (published != null && verifies(row.record, published) {}) {
                synchronized(this) { complete(row, published) }; return@execute
            }
            output.discard(row)
            synchronized(this) { save(row.copy(record = row.record.copy(state = DownloadState.CANCELLED, bytes = 0, error = null), pending = null, publishing = null, deleting = false)) }
        } catch (_: Exception) {
            synchronized(this) { save(row.copy(record = row.record.copy(state = DownloadState.FAILED, error = "LOCAL_STORAGE_FAILED"))) }
        }
    }
    @Synchronized private fun update(ticket: Ticket, change: (DownloadEntry) -> DownloadEntry): DownloadEntry {
        ticket.check(); return change(rows.getValue(ticket.id)).also(::save)
    }
    private fun verifies(record: DownloadRecord, uri: Uri, check: () -> Unit): Boolean = output.reader(uri).use {
        DownloadBytes.verify(it, record.totalBytes!!, record.contentVersion!!, check)
    }
    private fun complete(row: DownloadEntry, uri: Uri) = save(row.copy(record = row.record.copy(state = DownloadState.COMPLETED, uri = uri, error = null), pending = null, publishing = null, deleting = false))

    private fun transfer(ticket: Ticket, client: ProductClient?, connection: MobileConnection) {
        val row = update(ticket) { it.copy(record = it.record.copy(state = DownloadState.RUNNING)) }
        output.published(row)?.let { uri ->
            if (!verifies(row.record, uri, ticket::check)) throw ProtocolFailure("CONTENT_HASH_MISMATCH")
            synchronized(this) { ticket.check(); complete(row, uri) }; return
        }
        if (row.pending != null && row.record.totalBytes != null && row.record.bytes == row.record.totalBytes && output.pending(row, false) == row.pending) {
            verifyAndPublish(ticket); return
        }
        DownloadCacheSource.open(context, cache, row.record, ticket::check)?.use { local ->
            receive(ticket, local.spec) { offset, count, output, buffer ->
                local.stream.channel.position(offset)
                DownloadBytes.copy(local.stream, output, count, buffer, ticket::check)
            }
        } ?: run {
            val identity = client?.identity ?: throw ProtocolFailure("NOT_CONNECTED")
            if (identity.partition != row.record.partition) throw ProtocolFailure("DATA_GENERATION_CHANGED")
            val reusable = row.downloadId != null && row.record.contentVersion != null && row.record.totalBytes != null &&
                runCatching { java.time.Instant.parse(row.expiresAt).isAfter(client.serverNow()) }.getOrDefault(false)
            val (downloadId, spec) = if (reusable) row.downloadId!! to DownloadSpec(row.record.resourceId, row.record.contentVersion!!,
                row.record.totalBytes!!, row.record.name, row.record.mimeType) else {
                val prepared = client.prepareDownload(JSONObject().put("resourceId", row.record.resourceId).put("expectedVersion", row.record.revision), ticket::check)
                val source = DownloadSpec.parse(prepared)
                val id = prepared.getString("downloadId")
                update(ticket) { it.copy(record = source.bind(it.record), downloadId = id, expiresAt = prepared.getString("expiresAt")) }
                id to source
            }
            try {
                connection.http(identity) { transport, credential ->
                    ticket.transport = transport
                    try { receive(ticket, spec) { offset, _, output, buffer ->
                        DownloadBytes.fetch(transport, credential, downloadId, spec, offset, output, buffer, ticket::check)
                    } } finally { ticket.transport = null }
                }
            } catch (e: ProtocolFailure) {
                if (e.code == "RESOURCE_UNAVAILABLE") update(ticket) { it.copy(downloadId = null, expiresAt = null) }
                throw e
            }
        }
        verifyAndPublish(ticket)
    }
    private fun receive(ticket: Ticket, spec: DownloadSpec, range: (Long, Long, java.io.OutputStream, ByteArray) -> Unit) {
        var row = update(ticket) { it.copy(record = spec.bind(it.record)) }
        val uri = output.pending(row, true) ?: throw ProtocolFailure("LOCAL_STORAGE_FAILED")
        row = synchronized(this) {
            val latest = rows.getValue(ticket.id).copy(pending = uri, publishing = null)
            save(latest); ticket.check(); latest
        }
        val buffer = ByteArray(64 * 1024)
        output.writer(uri).use { stream ->
            var offset = row.record.bytes.takeIf { it in 0..spec.size && it <= stream.channel.size() } ?: 0L
            stream.channel.truncate(offset); stream.channel.position(offset)
            if (offset != row.record.bytes) update(ticket) { it.copy(record = it.record.copy(bytes = offset)) }
            while (offset < spec.size) {
                ticket.check(); val n = DownloadBytes.length(offset, spec.size)
                range(offset, n, stream, buffer)
                stream.fd.sync(); offset += n
                update(ticket) { it.copy(record = it.record.copy(bytes = offset)) }
            }
            stream.fd.sync()
        }
    }
    private fun verifyAndPublish(ticket: Ticket) {
        var row = update(ticket) { it.copy(record = it.record.copy(state = DownloadState.VERIFYING)) }
        val uri = row.pending ?: throw ProtocolFailure("LOCAL_STORAGE_FAILED")
        if (!verifies(row.record, uri, ticket::check)) {
            update(ticket) { it.copy(record = it.record.copy(bytes = 0), publishing = null) }
            throw ProtocolFailure("CONTENT_HASH_MISMATCH")
        }
        val finalName = row.publishing ?: output.publishName(row)
        row = update(ticket) { it.copy(publishing = finalName) }
        val result = output.publish(row)
        synchronized(this) { ticket.check(); complete(row, result) }
    }
}
