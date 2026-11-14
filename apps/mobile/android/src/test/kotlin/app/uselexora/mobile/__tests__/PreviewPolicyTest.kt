package app.uselexora.mobile

import app.uselexora.mobile.preview.PreviewKind
import app.uselexora.mobile.preview.PreviewPolicy
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class PreviewPolicyTest {
    @Test fun activeAndUnknownContentNeverEntersNativePreview() {
        assertEquals(PreviewKind.TEXT, PreviewPolicy.kind("notes.md", "text/markdown; charset=utf-8"))
        assertEquals(PreviewKind.IMAGE, PreviewPolicy.kind("photo.jpg", "IMAGE/JPEG"))
        assertEquals(PreviewKind.PDF, PreviewPolicy.kind("report.pdf", "application/pdf"))
        for ((name, mime) in listOf("page.html" to "text/plain", "image.SVG" to "image/png", "unknown" to "image/svg+xml", "data" to "text/html", "archive.zip" to "application/octet-stream")) assertNull(PreviewPolicy.kind(name, mime))
    }
    @Test fun previewPathsCannotEscapeTheDownloadedFileDirectory() {
        val root = Files.createTempDirectory("preview-policy").toFile()
        try {
            val directory = root.resolve("exports").apply { mkdir() }
            val file = directory.resolve("download.txt").apply { writeText("public output") }
            val secret = root.resolve("credential.bin").apply { writeText("synthetic") }
            assertEquals(file.canonicalFile, PreviewPolicy.exportedFile(directory, file.path))
            assertTrue(runCatching { PreviewPolicy.exportedFile(directory, directory.resolve("../credential.bin").path) }.isFailure)
            val link = directory.resolve("alias.txt")
            Files.createSymbolicLink(link.toPath(), secret.toPath())
            assertTrue(runCatching { PreviewPolicy.exportedFile(directory, link.path) }.isFailure)
        } finally { root.deleteRecursively() }
    }
}
