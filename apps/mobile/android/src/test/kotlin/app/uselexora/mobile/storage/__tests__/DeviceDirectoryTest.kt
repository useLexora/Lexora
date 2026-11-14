package app.uselexora.mobile.storage

import app.uselexora.mobile.protocol.ProtocolFailure
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DeviceDirectoryTest {
    private fun credential(name: String, device: String = "device-$name") = JSONObject().put("stage", "active")
        .put("endpoint", "https://$name.example:19443").put("spkiPin", "synthetic-pin-$name")
        .put("serviceId", "service-$name").put("profileId", "profile-$name").put("dataGeneration", "generation-$name")
        .put("deviceId", device).put("credential", "synthetic-credential-$device")
    private fun pair(directory: DeviceDirectory, credential: JSONObject) {
        val pending = directory.beginPairing(JSONObject().put("stage", "prepared"), directory.selection())
        directory.completePairing(pending, credential)
    }
    private fun assertSourceChanged(action: () -> Unit) {
        try { action(); fail("Expected the stale operation to be rejected") }
        catch (failure: ProtocolFailure) { assertEquals("SOURCE_CHANGED", failure.code) }
    }
    @Test fun hostPlatformSurvivesOfflineRestoreWithoutChangingCredentialsOrAnotherService() {
        val original = credential("first")
        val directory = DeviceDirectory(original)
        val first = directory.active()!!
        assertTrue(directory.connected(first, "Studio", "linux"))
        assertEquals(original.toString(), directory.active()!!.credential.toString())
        val restored = DeviceDirectory(JSONObject(directory.value.toString()))
        assertEquals("linux", restored.savedDevices().single().platform)
        pair(restored, credential("second"))
        assertFalse(restored.connected(first, "Wrong", "win32"))
        assertNull(restored.savedDevices().first { it.selected }.platform)
        assertEquals("linux", restored.savedDevices().first { it.id == first.id }.platform)
        restored.select(first.id)
        assertTrue(restored.connected(restored.active()!!, "Studio"))
        assertEquals("linux", restored.savedDevices().first { it.selected }.platform)
    }

    @Test fun legacyAutomaticNamesUseHostWhileCustomChineseNamesArePreserved() {
        val directory = DeviceDirectory(credential("first"))
        val entry = directory.value.getJSONArray("devices").getJSONObject(0)
        entry.put("name", "已配对服务")
        assertEquals("first.example", directory.savedDevices().single().name)
        directory.connected(directory.active()!!, "已配对服务")
        assertEquals("已配对服务", directory.savedDevices().single().name)
        directory.rename(directory.active()!!.id, "已配对服务")
        assertEquals("已配对服务", directory.savedDevices().single().name)
        directory.connected(directory.active()!!, "Host")
        assertEquals("已配对服务", directory.savedDevices().single().name)
    }

    @Test fun legacyIdentityMigratesWithoutChangingCredentialsOrSelectedDevice() {
        val original = credential("first")
        val directory = DeviceDirectory(original)
        val selected = directory.active()!!
        assertEquals(original.toString(), selected.credential.toString())
        assertEquals("first.example", directory.savedDevices().single().name)
        assertEquals(0L, directory.savedDevices().single().lastConnectedAt)
        val restored = DeviceDirectory(JSONObject(directory.value.toString()))
        assertEquals(selected.id, restored.active()!!.id)
        assertEquals(original.toString(), restored.current()!!.toString())
    }
    @Test fun unfinishedSecondPairingKeepsTheWorkingComputerAndResumesItsOwnState() {
        val first = credential("first")
        val second = credential("second")
        val directory = DeviceDirectory(first)
        val firstId = directory.active()!!.id
        val pending = directory.beginPairing(JSONObject().put("stage", "prepared"), directory.selection())
        directory.advancePairing(pending, JSONObject().put("stage", "credential_saved").put("credential", "synthetic-pending"))
        val restored = DeviceDirectory(JSONObject(directory.value.toString()))
        assertEquals(first.toString(), restored.current()!!.toString())
        assertEquals("credential_saved", restored.pending()!!.state.getString("stage"))
        restored.completePairing(restored.pending()!!, second)
        assertEquals(2, restored.savedDevices().size)
        assertEquals(second.toString(), restored.current()!!.toString())
        assertTrue(restored.select(firstId))
        assertEquals(first.toString(), restored.current()!!.toString())
    }
    @Test fun switchingAwayAndBackInvalidatesLateEndpointUpdatesAndRemoval() {
        val directory = DeviceDirectory(credential("first"))
        val firstId = directory.active()!!.id
        pair(directory, credential("second"))
        val secondId = directory.active()!!.id
        directory.select(firstId)
        val old = directory.active()!!
        directory.select(secondId)
        assertFalse(directory.update(old, JSONObject(old.credential.toString()).put("endpoint", "https://changed.example")))
        assertFalse(directory.matches(old))
        assertEquals("service-second", directory.current()!!.getString("serviceId"))
        directory.select(firstId)
        assertFalse(directory.update(old, JSONObject(old.credential.toString()).put("credential", "late-credential")))
        assertFalse(directory.matches(old))
        assertEquals(credential("first").toString(), directory.current()!!.toString())
    }
    @Test fun latePairingCannotReplaceAnotherPendingAttemptOrChangeASelectedComputer() {
        val directory = DeviceDirectory(credential("first"))
        val firstId = directory.active()!!.id
        pair(directory, credential("second"))
        val secondId = directory.active()!!.id
        directory.select(firstId)
        val old = directory.beginPairing(JSONObject().put("stage", "prepared").put("attempt", "old"), directory.selection())
        val replacement = directory.beginPairing(JSONObject().put("stage", "prepared").put("attempt", "new"), directory.selection())
        assertSourceChanged { directory.advancePairing(old, JSONObject().put("stage", "credential_saved")) }
        assertSourceChanged { directory.completePairing(old, credential("third")) }
        directory.select(secondId)
        assertSourceChanged { directory.completePairing(replacement, credential("third")) }
        assertEquals("service-second", directory.current()!!.getString("serviceId"))
        assertEquals(2, directory.savedDevices().size)
    }
    @Test fun pairingTheSameComputerAgainRetainsItsNameAndDirectoryIdentity() {
        val directory = DeviceDirectory(credential("first"))
        val firstId = directory.active()!!.id
        directory.rename(firstId, "工作服务")
        pair(directory, credential("first", "replacement-device"))
        assertEquals(1, directory.savedDevices().size)
        assertEquals(firstId, directory.active()!!.id)
        assertEquals("工作服务", directory.savedDevices().single().name)
        assertEquals("replacement-device", directory.current()!!.getString("deviceId"))
        assertTrue(directory.savedDevices().single().lastConnectedAt > 0)
    }
    @Test fun forgettingTheSelectedComputerDoesNotSelectAnotherOrResumeAnUnfinishedPairing() {
        val directory = DeviceDirectory(credential("first"))
        val firstId = directory.active()!!.id
        pair(directory, credential("second"))
        val secondId = directory.active()!!.id
        directory.beginPairing(JSONObject().put("stage", "prepared"), directory.selection())
        directory.forget(secondId)
        assertNull(directory.active())
        assertNull(directory.current())
        assertEquals(firstId, directory.savedDevices().single().id)
        assertFalse(directory.savedDevices().single().selected)
        directory.select(firstId)
        assertEquals("service-first", directory.current()!!.getString("serviceId"))
    }
    @Test fun legacyPendingPairingRemainsReadableUntilItsOwnCompletion() {
        val original = JSONObject().put("stage", "credential_saved").put("credential", "synthetic")
        val directory = DeviceDirectory(original)
        assertEquals(original.toString(), directory.current()!!.toString())
        assertTrue(directory.savedDevices().isEmpty())
        directory.completePairing(directory.pending()!!, credential("first"))
        assertNull(directory.pending())
        assertEquals("service-first", directory.current()!!.getString("serviceId"))
    }
}
