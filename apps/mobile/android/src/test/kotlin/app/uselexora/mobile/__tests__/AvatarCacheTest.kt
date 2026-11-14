package app.uselexora.mobile

import app.uselexora.mobile.storage.AvatarCache
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class AvatarCacheTest {
    private fun avatar(bytes: ByteArray) = JSONObject().put("kind", "image").put("sha256", AvatarCache.hash(bytes)).put("mimeType", "image/png").put("sizeBytes", bytes.size)

    @Test fun partitionVersionIntegrityAndExpiryAreEnforced() {
        val directory = Files.createTempDirectory("avatar-cache").toFile()
        try {
            val cache = AvatarCache(directory)
            val bytes = byteArrayOf(1, 2, 3); val metadata = avatar(bytes)
            cache.write("service/profile/generation/device", metadata, bytes)
            assertArrayEquals(bytes, AvatarCache(directory).read("service/profile/generation/device", metadata))
            for (partition in listOf("other/profile/generation/device", "service/other/generation/device", "service/profile/other/device", "service/profile/generation/other")) assertNull(cache.read(partition, metadata))
            assertNull(cache.read("service/profile/generation/device", avatar(byteArrayOf(4, 5, 6))))
            directory.listFiles()!!.single().writeBytes(byteArrayOf(1, 3, 2))
            assertNull(cache.read("service/profile/generation/device", metadata))
            cache.write("service/profile/generation/device", metadata, bytes)
            directory.listFiles()!!.single().setLastModified(System.currentTimeMillis() - 8L * 24 * 60 * 60 * 1000)
            assertNull(cache.read("service/profile/generation/device", metadata))
            assertThrows(IllegalArgumentException::class.java) { cache.write("service", metadata, byteArrayOf(3, 2, 1)) }
        } finally { directory.deleteRecursively() }
    }

    @Test fun quotaAndAtomicReplacementKeepOnlyCompleteImages() {
        val directory = Files.createTempDirectory("avatar-cache").toFile()
        try {
            val cache = AvatarCache(directory, 7)
            val one = byteArrayOf(1, 2, 3, 4); val two = byteArrayOf(5, 6, 7, 8)
            cache.write("owner", avatar(one), one)
            directory.resolve("interrupted.image.tmp").writeBytes(one)
            cache.write("owner", avatar(two), two)
            assertNull(cache.read("owner", avatar(one)))
            assertArrayEquals(two, cache.read("owner", avatar(two)))
            assertTrue(directory.listFiles()!!.none { it.name.endsWith(".tmp") })
        } finally { directory.deleteRecursively() }
    }
}
