package app.uselexora.mobile.network

import android.content.Context
import app.uselexora.mobile.protocol.ProductIdentity
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.DeviceRegistry
import app.uselexora.mobile.storage.DeviceSnapshot
import app.uselexora.mobile.storage.SavedDevice
import app.uselexora.mobile.storage.SecretStore
import org.json.JSONObject

class MobileConnection(context: Context, private val schemas: ProtocolSchemas, private val version: String, private val secrets: SecretStore = SecretStore(context)) {
    private val devices = DeviceRegistry(secrets)
    private val connectionLock = Any()
    private var connectionGeneration = 0L
    private var activeClient: ProductClient? = null
    fun savedDevices(): List<SavedDevice> = devices.savedDevices()
    fun activeDeviceId(): String? = devices.selection().id
    fun selectDevice(id: String): Boolean = synchronized(connectionLock) {
        devices.select(id).also { if (it) closeActive() }
    }
    fun renameDevice(id: String, name: String) = devices.rename(id, name)
    fun forgetDevice(id: String) = synchronized(connectionLock) {
        val selected = id == devices.selection().id
        devices.forget(id)
        if (selected) closeActive()
    }
    private fun closeActive() {
        connectionGeneration++
        val previous = activeClient
        activeClient = null
        previous?.close()
    }
    fun connect(): ProductClient? {
        val generation = synchronized(connectionLock) { closeActive(); connectionGeneration }
        PairingClient(secrets, schemas, version).resume()
        val saved = devices.active() ?: return null
        val client = connectSaved(saved.credential)
        try {
            val serviceName = if (client.supports("service.info")) client.call("service.info", JSONObject()).getString("name") else null
            val platform = if (client.supports("service.host")) client.call("service.host", JSONObject()).getString("platform") else null
            val available = runCatching { client.fetchConnectionEndpoints() }.getOrDefault(emptyList())
                .takeIf { client.endpoint in it } ?: saved.credential.connectionEndpoints()
            val updated = JSONObject(saved.credential.toString()).saveEndpoints(client.endpoint, available)
            synchronized(connectionLock) {
                if (generation != connectionGeneration || !devices.connected(saved, serviceName, platform, updated)) throw ProtocolFailure("SOURCE_CHANGED")
                activeClient = client
            }
            return client
        } catch (failure: Throwable) { client.close(); throw failure }
    }
    fun description(): JSONObject? {
        val saved = devices.active()?.credential ?: return null
        return JSONObject().apply { for (key in listOf("endpoint", "serviceId", "profileId", "dataGeneration", "deviceId")) put(key, saved.getString(key)) }
    }
    fun hasSavedIdentity() = secrets.read() != null
    fun logout(expected: JSONObject): Boolean {
        val snapshot = expectedActive(expected) ?: return false
        val saved = snapshot.credential
        var revoked = false
        try {
            val endpoint = connectSaved(saved).let { client -> client.endpoint.also { client.close() } }
            val transport = PinnedTransport(endpoint, saved.getString("spkiPin"))
            try {
                val response = transport.json("/v1/device/logout", JSONObject(), saved.getString("credential"))
                if (!response.optBoolean("revoked")) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
                revoked = true
            } finally { transport.close() }
        } catch (error: Exception) { if (generateSequence<Throwable>(error) { it.cause }.take(12).none { it is ProtocolFailure && it.code == "NOT_AUTHORIZED" }) throw error }
        synchronized(connectionLock) {
            if (!devices.remove(snapshot)) throw ProtocolFailure("SOURCE_CHANGED")
            closeActive()
        }
        return revoked
    }
    fun forget(expected: JSONObject?) = synchronized(connectionLock) {
        val snapshot = expectedActive(expected)
        if (snapshot != null) {
            if (!devices.remove(snapshot)) throw ProtocolFailure("SOURCE_CHANGED")
        } else {
            val saved = secrets.read() ?: return@synchronized
            if (saved.optString("stage") == "active" || !secrets.clearIfMatches(saved)) throw ProtocolFailure("SOURCE_CHANGED")
        }
        closeActive()
    }
    private fun expectedActive(expected: JSONObject?): DeviceSnapshot? {
        val snapshot = devices.active() ?: run {
            if (expected != null && secrets.read() != null) throw ProtocolFailure("SOURCE_CHANGED")
            return null
        }
        if (expected == null || listOf("serviceId", "profileId", "dataGeneration", "deviceId").any { snapshot.credential.optString(it) != expected.optString(it) }) throw ProtocolFailure("SOURCE_CHANGED")
        return snapshot
    }
    private fun refreshPairedDevice(qr: JSONObject): ProductIdentity? {
        val snapshot = devices.active() ?: return null
        val saved = snapshot.credential
        if (listOf("serviceId", "profileId", "spkiPin").any { qr.getString(it) != saved.getString(it) }) return null
        val endpoints = qr.connectionEndpoints()
        val candidate = try {
            tryConnectionEndpoints(endpoints) { verifiedClient(saved, it, endpoints.size > 1) }
        } catch (failure: Exception) {
            val cause = if (failure is java.util.concurrent.ExecutionException) failure.cause else failure
            if (cause is ProtocolFailure && cause.code in setOf("NOT_AUTHORIZED", "DATA_GENERATION_CHANGED")) return null
            throw failure
        }
        try {
            val updated = JSONObject(saved.toString()).saveEndpoints(candidate.endpoint, endpoints)
            synchronized(connectionLock) {
                if (!devices.update(snapshot, updated)) throw ProtocolFailure("SOURCE_CHANGED")
                closeActive()
            }
            return candidate.identity!!
        } finally { candidate.close() }
    }
    private fun connectSaved(saved: JSONObject): ProductClient {
        val endpoints = saved.connectionEndpoints()
        return tryConnectionEndpoints(endpoints) { verifiedClient(saved, it, endpoints.size > 1) }
    }
    private fun verifiedClient(saved: JSONObject, endpoint: String, hasFallback: Boolean = false): ProductClient {
        val client = ProductClient(PinnedTransport(endpoint, saved.getString("spkiPin"), if (hasFallback) 3 else 10), saved.getString("credential"), schemas)
        try {
            val identity = client.connect(version, if (hasFallback) 5 else 15)
            if (identity.serviceId != saved.getString("serviceId") || identity.profileId != saved.getString("profileId") || identity.dataGeneration != saved.getString("dataGeneration") || identity.deviceId != saved.getString("deviceId")) throw ProtocolFailure("DATA_GENERATION_CHANGED")
            return client
        } catch (failure: Throwable) { client.close(); throw failure }
    }
    fun <T> http(identity: ProductIdentity, operation: (PinnedTransport, String) -> T): T {
        val saved = devices.active()?.credential ?: throw ProtocolFailure("NOT_CONNECTED")
        if (saved.optString("serviceId") != identity.serviceId || saved.optString("profileId") != identity.profileId || saved.optString("dataGeneration") != identity.dataGeneration || saved.optString("deviceId") != identity.deviceId) throw ProtocolFailure("DATA_GENERATION_CHANGED")
        val transport = PinnedTransport(saved.getString("endpoint"), saved.getString("spkiPin"))
        return try { operation(transport, saved.getString("credential")) } finally { transport.close() }
    }
    fun pair(code: String): ProductIdentity {
        synchronized(connectionLock) { closeActive() }
        val pairing = PairingClient(secrets, schemas, version)
        val qr = pairing.readCode(code)
        return refreshPairedDevice(qr) ?: pairing.start(qr, android.os.Build.MODEL.take(80))
    }
}
