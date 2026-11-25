package app.uselexora.mobile.network

import app.uselexora.mobile.protocol.ProductIdentity
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.SecretStore
import app.uselexora.mobile.storage.DeviceRegistry
import app.uselexora.mobile.storage.PendingPairing
import org.json.JSONObject

class PairingClient(private val secrets: SecretStore, private val schemas: ProtocolSchemas, private val version: String) {
    private val devices = DeviceRegistry(secrets)
    fun start(raw: String, deviceName: String): ProductIdentity = start(readCode(raw), deviceName)

    internal fun readCode(raw: String): JSONObject {
        val qr = JSONObject(raw)
        if (!schemas.valid(qr, schemas.document.getJSONObject("pairing").getJSONObject("pairingQrSchema"))) throw ProtocolFailure("INVALID_PAIRING_CODE")
        if (java.time.Instant.parse(qr.getString("expiresAt")).isBefore(java.time.Instant.now())) throw ProtocolFailure("PAIRING_EXPIRED")
        return qr
    }

    internal fun start(qr: JSONObject, deviceName: String): ProductIdentity {
        val selection = devices.selection()
        devices.pending()?.takeIf { it.selection == selection && it.state.optJSONObject("qr")?.toString() == qr.toString() }?.let { return finish(it) }
        val transport = pairingTransport(qr)
        val context = JSONObject().apply { for (key in listOf("serviceId", "profileId", "issuerInstanceId", "ticketId", "ticketSecret")) put(key, qr.get(key)) }
        val attempt = try { transport.json("/v1/pairing/prepare", JSONObject(context.toString()).put("deviceName", deviceName)) }
        finally { transport.close() }
        validate("pairingPrepareResultSchema", attempt)
        val state = JSONObject().put("stage", "prepared").put("qr", qr).put("attempt", attempt).put("endpoint", transport.endpoint)
        return finish(devices.beginPairing(state, selection))
    }
    fun resume(): ProductIdentity? {
        if (devices.active() != null) return null
        val pending = devices.pending()?.takeIf { it.selection == devices.selection() } ?: return null
        return finish(pending)
    }
    private fun finish(initial: PendingPairing): ProductIdentity {
        var pending = initial
        val saved = JSONObject(initial.state.toString())
        val qr = saved.getJSONObject("qr")
        val attempt = saved.getJSONObject("attempt")
        val transport = pairingTransport(qr, saved.optString("endpoint"))
        try {
            if (!saved.has("credential")) {
                val recovery = JSONObject().put("serviceId", qr.getString("serviceId")).put("profileId", qr.getString("profileId")).put("attemptId", attempt.getString("attemptId")).put("recoverySecret", attempt.getString("recoverySecret"))
                val redeem = JSONObject(recovery.toString()).put("issuerInstanceId", qr.getString("issuerInstanceId")).put("ticketId", qr.getString("ticketId")).put("ticketSecret", qr.getString("ticketSecret"))
                val credential = try { transport.json("/v1/pairing/redeem", redeem) } catch (failure: ProtocolFailure) {
                    if (failure.code != "RECOVERY_REQUIRED") throw failure
                    transport.json("/v1/pairing/recover", recovery)
                }
                validate("deviceCredentialSchema", credential)
                saved.put("credentialRecord", credential).put("credential", "${credential.getString("credentialId")}.${credential.getString("credentialSecret")}").put("stage", "credential_saved")
                pending = devices.advancePairing(pending, saved)
            }
            val credential = saved.getString("credential")
            val confirmed = transport.json("/v1/pairing/confirm", JSONObject(), credential)
            validate("deviceStateSchema", confirmed)
            val client = ProductClient(transport, credential, schemas)
            try {
                val identity = client.connect(version)
                if (identity.serviceId != qr.getString("serviceId") || identity.profileId != qr.getString("profileId") || identity.deviceId != saved.getJSONObject("credentialRecord").getString("deviceId")) throw ProtocolFailure("TLS_IDENTITY_MISMATCH")
                saved.saveEndpoints(transport.endpoint, qr.connectionEndpoints()).put("stage", "active").put("spkiPin", qr.getString("spkiPin")).put("serviceId", identity.serviceId).put("profileId", identity.profileId).put("dataGeneration", identity.dataGeneration).put("deviceId", identity.deviceId)
                saved.remove("qr"); saved.remove("attempt")
                devices.completePairing(pending, saved)
                client.reportDeviceProfile(version)
                return identity
            } finally { client.close() }
        } finally { transport.close() }
    }
    private fun pairingTransport(qr: JSONObject, preferred: String = ""): PinnedTransport {
        val endpoints = qr.connectionEndpoints()
        val pin = qr.getString("spkiPin")
        if (endpoints.size == 1) return PinnedTransport(endpoints.single(), pin)
        val ordered = endpoints.sortedBy { it != preferred }
        return tryConnectionEndpoints(ordered) { endpoint ->
            val transport = PinnedTransport(endpoint, pin, connectTimeoutSeconds = 3)
            try {
                transport.request("/v1/connection-info", timeoutMs = 4000).use { response ->
                    if (!response.isSuccessful) throw ProtocolFailure("SERVICE_UNREACHABLE")
                    val info = JSONObject(response.peekBody(8192).string())
                    if (info.optString("serviceId") != qr.getString("serviceId") || info.optString("profileId") != qr.getString("profileId")) throw ProtocolFailure("TLS_IDENTITY_MISMATCH")
                }
                transport
            } catch (failure: Exception) {
                transport.close()
                throw failure
            }
        }
    }
    private fun validate(schema: String, value: JSONObject) {
        if (!schemas.valid(value, schemas.document.getJSONObject("pairing").getJSONObject(schema))) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
    }
}
