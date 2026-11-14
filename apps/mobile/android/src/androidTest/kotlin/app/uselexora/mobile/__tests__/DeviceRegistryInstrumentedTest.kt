package app.uselexora.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.PairingClient
import app.uselexora.mobile.protocol.ProtocolFailure
import okhttp3.CertificatePinner
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import java.time.Instant
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.DeviceRegistry
import app.uselexora.mobile.storage.SecretStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class DeviceRegistryInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun credential(name: String) = JSONObject().put("stage", "active").put("endpoint", "https://$name.example")
        .put("serviceId", "service-$name").put("profileId", "profile-$name").put("dataGeneration", "generation-$name")
        .put("deviceId", "device-$name").put("spkiPin", "synthetic-pin").put("credential", "synthetic-$name")
    @Test fun encryptedLegacyMigrationAndConditionalRemovalPreserveOtherComputers() {
        val namespace = "test-devices-${UUID.randomUUID()}"
        val store = SecretStore(context, namespace)
        val other = SecretStore(context, namespace)
        try {
            val first = credential("first")
            store.write(first)
            val devices = DeviceRegistry(store)
            val firstId = devices.savedDevices().single().id
            assertEquals(first.toString(), other.read()!!.toString())
            val pending = devices.beginPairing(JSONObject().put("stage", "prepared"), devices.selection())
            devices.completePairing(pending, credential("second"))
            val secondId = devices.active()!!.id
            assertFalse(other.clearIfMatches(first))
            devices.select(firstId)
            assertTrue(other.clearIfMatches(first))
            assertNull(store.read())
            val restored = DeviceRegistry(other)
            assertEquals(secondId, restored.savedDevices().single().id)
            restored.select(secondId)
            assertEquals(credential("second").toString(), store.read()!!.toString())
        } finally { store.clear() }
    }
    @Test fun failedPairingWithAnotherComputerKeepsTheWorkingIdentityAndItsRecoveryState() {
        val store = SecretStore(context, "test-pairing-failure-${UUID.randomUUID()}")
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val server = MockWebServer().apply {
            useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            start()
        }
        try {
            val first = credential("first")
            store.write(first)
            val expiry = Instant.now().plusSeconds(120).toString()
            val qr = JSONObject().put("format", "lexora-pairing").put("version", 1)
                .put("serviceId", "service-second").put("profileId", "profile-second").put("issuerInstanceId", "instance-second")
                .put("ticketId", "ticket-second").put("ticketSecret", "s".repeat(43)).put("expiresAt", expiry)
                .put("endpoint", server.url("/").toString().trimEnd('/')).put("spkiPin", CertificatePinner.pin(certificate.certificate))
            server.enqueue(MockResponse().setBody(JSONObject().put("attemptId", "attempt-second").put("recoverySecret", "r".repeat(43)).put("expiresAt", expiry).toString()))
            server.enqueue(MockResponse().setResponseCode(503).setBody(JSONObject().put("error", "PAIRING_UNAVAILABLE").toString()))
            val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
            val pairing = PairingClient(store, schemas, BuildConfig.VERSION_NAME)
            try { pairing.start(qr.toString(), "Test phone"); fail("The second computer should reject pairing") }
            catch (failure: ProtocolFailure) { assertEquals("PAIRING_UNAVAILABLE", failure.code) }
            assertEquals(first.toString(), store.read()!!.toString())
            assertEquals("prepared", DeviceRegistry(store).pending()!!.state.getString("stage"))
            assertNull(pairing.resume())
            assertEquals(2, server.requestCount)
        } finally { store.clear(); server.shutdown() }
    }
}
