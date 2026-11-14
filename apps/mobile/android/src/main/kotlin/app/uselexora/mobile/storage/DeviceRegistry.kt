package app.uselexora.mobile.storage

import app.uselexora.mobile.protocol.ProtocolFailure
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.UUID

data class SavedDevice(val id: String, val name: String, val endpoint: String, val lastConnectedAt: Long, val selected: Boolean, val platform: String? = null)
internal data class DeviceSelection(val id: String?, val revision: Long)
internal data class DeviceSnapshot(val id: String, val selection: DeviceSelection, val credential: JSONObject)
internal data class PendingPairing(val id: String, val selection: DeviceSelection, val state: JSONObject)

internal class DeviceRegistry(private val secrets: SecretStore) {
    fun savedDevices(): List<SavedDevice> = secrets.devices { it.savedDevices() }
    fun selection(): DeviceSelection = secrets.devices { it.selection() }
    fun active(): DeviceSnapshot? = secrets.devices { it.active() }
    fun select(id: String): Boolean = secrets.devices { it.select(id) }
    fun rename(id: String, name: String) = secrets.devices { it.rename(id, name) }
    fun forget(id: String) = secrets.devices { it.forget(id) }
    fun remove(snapshot: DeviceSnapshot): Boolean = secrets.devices { if (!it.matches(snapshot)) false else { it.forget(snapshot.id); true } }
    fun update(snapshot: DeviceSnapshot, value: JSONObject): Boolean = secrets.devices { it.update(snapshot, value) }
    fun connected(snapshot: DeviceSnapshot, serviceName: String? = null, platform: String? = null): Boolean = secrets.devices { it.connected(snapshot, serviceName, platform) }
    fun pending(): PendingPairing? = secrets.devices { it.pending() }
    fun beginPairing(state: JSONObject, selection: DeviceSelection): PendingPairing = secrets.devices { it.beginPairing(state, selection) }
    fun advancePairing(pending: PendingPairing, state: JSONObject): PendingPairing = secrets.devices { it.advancePairing(pending, state) }
    fun completePairing(pending: PendingPairing, credential: JSONObject) = secrets.devices { it.completePairing(pending, credential) }
}

internal class DeviceDirectory(stored: JSONObject?) {
    val value: JSONObject = if (isDirectory(stored)) copy(stored!!) else JSONObject().put("kind", KIND).put("version", 1)
        .put("selectionRevision", 0L).put("devices", JSONArray()).also { directory ->
            if (stored != null) {
                if (stored.optString("stage") == "active") {
                    val entry = entry(stored)
                    directory.getJSONArray("devices").put(entry)
                    directory.put("selectedDeviceId", entry.getString("id"))
                } else directory.put("pending", pendingValue(stored, DeviceSelection(null, 0L)))
            }
        }
    init { require(value.getInt("version") == 1) { "Unsupported device directory" } }
    private fun entries(): List<JSONObject> = value.getJSONArray("devices").let { values -> (0 until values.length()).map { values.getJSONObject(it) } }
    private fun selectedId(): String? = value.optString("selectedDeviceId").takeIf { it.isNotEmpty() }
    fun selection() = DeviceSelection(selectedId(), value.getLong("selectionRevision"))
    private fun advanceSelection(id: String?) {
        if (id == null) value.remove("selectedDeviceId") else value.put("selectedDeviceId", id)
        value.put("selectionRevision", value.getLong("selectionRevision") + 1)
    }
    fun current(): JSONObject? = active()?.credential ?: pending()?.takeIf { it.selection == selection() }?.state
    fun active(): DeviceSnapshot? = entries().firstOrNull { it.getString("id") == selectedId() }
        ?.let { DeviceSnapshot(it.getString("id"), selection(), copy(it.getJSONObject("credential"))) }
    fun savedDevices(): List<SavedDevice> = entries().map {
        SavedDevice(it.getString("id"), it.getString("name").let { name -> if (name == "已配对服务" && !it.optBoolean("customName") && !it.has("automaticName")) URI(it.getJSONObject("credential").getString("endpoint")).host else name }, it.getJSONObject("credential").getString("endpoint"), it.optLong("lastConnectedAt"), it.getString("id") == selectedId(), it.optString("platform").takeIf(String::isNotBlank))
    }.sortedWith(compareByDescending<SavedDevice> { it.selected }.thenByDescending { it.lastConnectedAt })
    fun select(id: String): Boolean {
        requireEntry(id)
        if (id == selectedId()) return false
        advanceSelection(id)
        return true
    }
    fun rename(id: String, name: String) {
        val normalized = name.trim()
        require(normalized.isNotEmpty() && normalized.length <= 80 && normalized.none { it.isISOControl() }) { "Invalid device name" }
        requireEntry(id).put("name", normalized).put("customName", true)
    }
    fun forget(id: String) {
        requireEntry(id)
        value.put("devices", JSONArray(entries().filter { it.getString("id") != id }))
        if (id == selectedId()) advanceSelection(null)
    }
    fun matches(snapshot: DeviceSnapshot): Boolean = snapshot.selection == selection() && active()?.credential?.toString() == snapshot.credential.toString()
    fun update(snapshot: DeviceSnapshot, credential: JSONObject): Boolean {
        if (!matches(snapshot)) return false
        requireEntry(snapshot.id).put("credential", copy(credential))
        return true
    }
    fun connected(snapshot: DeviceSnapshot, serviceName: String? = null, platform: String? = null): Boolean {
        if (!matches(snapshot)) return false
        val entry = requireEntry(snapshot.id)
        val oldName = entry.getString("name")
        val endpointHost = runCatching { URI(snapshot.credential.getString("endpoint")).host }.getOrNull()
        val automatic = !entry.optBoolean("customName") && (oldName == endpointHost || oldName == "已配对服务" || oldName == entry.optString("automaticName"))
        if (automatic && !serviceName.isNullOrBlank()) {
            entry.put("name", serviceName.take(253)).put("automaticName", serviceName.take(253))
        }
        if (platform != null) entry.put("platform", platform)
        entry.put("lastConnectedAt", System.currentTimeMillis())
        return true
    }
    fun pending(): PendingPairing? = value.optJSONObject("pending")?.let {
        PendingPairing(it.getString("id"), DeviceSelection(it.optString("selectedDeviceId").takeIf(String::isNotEmpty), it.getLong("selectionRevision")), copy(it.getJSONObject("state")))
    }
    fun beginPairing(state: JSONObject, expected: DeviceSelection): PendingPairing {
        if (selection() != expected) throw ProtocolFailure("SOURCE_CHANGED")
        value.put("pending", pendingValue(state, expected))
        return pending()!!
    }
    private fun requirePending(expected: PendingPairing): JSONObject {
        val current = pending()
        if (selection() != expected.selection || current == null || current.id != expected.id || current.state.toString() != expected.state.toString()) throw ProtocolFailure("SOURCE_CHANGED")
        return value.getJSONObject("pending")
    }
    fun advancePairing(expected: PendingPairing, state: JSONObject): PendingPairing {
        requirePending(expected).put("state", copy(state))
        return pending()!!
    }
    fun completePairing(expected: PendingPairing, credential: JSONObject) {
        requirePending(expected)
        val target = entries().firstOrNull { item ->
            val saved = item.getJSONObject("credential")
            saved.optString("serviceId") == credential.getString("serviceId") && saved.optString("profileId") == credential.getString("profileId")
        } ?: entry(credential).also { value.getJSONArray("devices").put(it) }
        target.put("credential", copy(credential)).put("lastConnectedAt", System.currentTimeMillis())
        value.remove("pending")
        advanceSelection(target.getString("id"))
    }
    fun replaceCurrent(credential: JSONObject) {
        if (credential.optString("stage") == "active") {
            val target = entries().firstOrNull { it.getString("id") == selectedId() }
                ?: entry(credential).also { value.getJSONArray("devices").put(it) }
            target.put("credential", copy(credential))
            value.remove("pending")
            advanceSelection(target.getString("id"))
        } else {
            selectedId()?.let { forget(it) }
            advanceSelection(null)
            value.put("pending", pendingValue(credential, selection()))
        }
    }
    fun removeCurrent() {
        selectedId()?.let { forget(it) } ?: value.remove("pending")
    }
    private fun requireEntry(id: String): JSONObject = entries().firstOrNull { it.getString("id") == id } ?: throw ProtocolFailure("SOURCE_CHANGED")
    companion object {
        private const val KIND = "lexora-device-directory"
        fun isDirectory(value: JSONObject?): Boolean = value?.optString("kind") == KIND
        private fun copy(value: JSONObject) = JSONObject(value.toString())
        private fun entry(credential: JSONObject): JSONObject {
            val endpoint = credential.getString("endpoint")
            val name = URI(endpoint).host
            return JSONObject().put("id", UUID.randomUUID().toString()).put("name", name).put("credential", copy(credential)).put("lastConnectedAt", 0L)
        }
        private fun pendingValue(state: JSONObject, selection: DeviceSelection): JSONObject = JSONObject()
            .put("id", UUID.randomUUID().toString()).put("state", copy(state)).put("selectionRevision", selection.revision)
            .apply { selection.id?.let { put("selectedDeviceId", it) } }
    }
}
