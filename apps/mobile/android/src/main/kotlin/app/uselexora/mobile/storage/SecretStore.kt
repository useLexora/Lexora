package app.uselexora.mobile.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecretStore(context: Context, namespace: String = "device-identity") {
    private val file = AtomicFile(File(context.noBackupFilesDir, "$namespace.bin"))
    private val alias = "lexora.mobile.$namespace.v1"
    fun read(): JSONObject? = synchronized(lock) { current(readUnlocked()) }
    private fun readUnlocked(): JSONObject? {
        if (!file.baseFile.exists()) return null
        val bytes = file.readFully()
        require(bytes.size > 28)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    }
    fun write(value: JSONObject) = synchronized(lock) {
        val stored = readUnlocked()
        if (DeviceDirectory.isDirectory(stored)) {
            val directory = DeviceDirectory(stored)
            directory.replaceCurrent(value)
            writeUnlocked(directory.value)
        } else writeUnlocked(value)
    }
    private fun writeUnlocked(value: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val data = cipher.iv + cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8))
        val output = file.startWrite()
        try { output.write(data); file.finishWrite(output) } catch (failure: Exception) { file.failWrite(output); throw failure }
    }
    fun clear() = synchronized(lock) { file.delete() }
    fun clearIfMatches(expected: JSONObject): Boolean = synchronized(lock) {
        val stored = readUnlocked()
        val current = current(stored) ?: return@synchronized true
        if (current.toString() != expected.toString()) return@synchronized false
        if (DeviceDirectory.isDirectory(stored)) {
            val directory = DeviceDirectory(stored)
            directory.removeCurrent()
            writeUnlocked(directory.value)
        } else file.delete()
        true
    }
    internal fun <T> devices(operation: (DeviceDirectory) -> T): T = synchronized(lock) {
        val stored = readUnlocked()
        val directory = DeviceDirectory(stored)
        val result = operation(directory)
        if (directory.value.toString() != stored?.toString()) writeUnlocked(directory.value)
        result
    }
    private fun current(value: JSONObject?): JSONObject? = if (DeviceDirectory.isDirectory(value)) DeviceDirectory(value).current() else value
    companion object { private val lock = Any() }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }
}
