package app.uselexora.mobile.ui

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class MobileSkinModelsTest {
    private val assets = File("build/generated/skins")
    private fun readAsset(path: String): String = File(assets, path).readText()
    private fun catalog() = MobileSkinCatalog.load(::readAsset)
    private fun paper() = JSONObject(readAsset("skins/paper/skin.json"))
    private fun keys(value: JSONObject) = value.keys().asSequence().toSet()

    @Test fun generatedPackagesHaveBothCompletePalettesAndPreserveThePaperPalette() {
        val skins = catalog().skins
        assertEquals(listOf("color-play", "paper", "mecha-armor"), skins.take(3).map { it.id })
        val classic = JSONObject(File("build/generated/reader/reader/appearance.json").readText())
        for (skin in skins) {
            assertEquals(skin.name.getValue("zh"), skin.label("zh"))
            assertEquals(skin.name.getValue("en"), skin.label("unsupported"))
            for (dark in listOf(false, true)) {
                val baseline = classic.getJSONObject(if (dark) "dark" else "light")
                val palette = skin.variant(dark).palette
                for (section in listOf("colors", "variables")) {
                    assertEquals(keys(baseline.getJSONObject(section)), keys(palette.getJSONObject(section)))
                    if (skin.id == "paper") {
                        for (key in keys(baseline.getJSONObject(section)))
                            assertEquals(baseline.getJSONObject(section).getString(key), palette.getJSONObject(section).getString(key))
                    }
                }
                assertEquals(palette.getJSONObject("colors").getString("canvas"), palette.getJSONObject("variables").getString("--buddy-surface-canvas"))
                assertEquals(palette.getJSONObject("colors").getString("link"), palette.getJSONObject("variables").getString("--link-color"))
            }
        }
        assertNull(skins.single { it.id == "paper" }.variant(false).home)
        assertNotEquals(skins.first().variant(false).palette.toString(), skins.first().variant(true).palette.toString())
        assertEquals(15, classic.getJSONObject("typography").getInt("bodySize"))
        assertEquals(24, classic.getJSONObject("typography").getInt("bodyLineHeight"))
    }

    @Test fun missingAndRemovedPreferencesRestoreColorPlayWithoutChangingValidIds() {
        val catalog = catalog()
        assertEquals("color-play", catalog.get(null).id)
        assertEquals("color-play", catalog.get("").id)
        assertEquals("color-play", catalog.get("removed-skin").id)
        for (skin in catalog.skins) assertEquals(skin.id, catalog.get(skin.id).id)
    }

    @Test fun aNewIndexedIdLoadsLocalizedNamesAndOpaqueHomeDataWithoutNativeChanges() {
        val newSkin = paper().put("id", "aurora").put("version", 2)
            .put("name", JSONObject().put("zh", "极光").put("en", "Aurora"))
        val home = JSONObject().put("schemaVersion", 1).put("futureLayout", JSONObject().put("image", "images/banner.png"))
        newSkin.getJSONObject("variants").getJSONObject("light").put("home", home)
        val catalog = MobileSkinCatalog.load { path ->
            when (path) {
                "skins/index.json" -> """{"schemaVersion":1,"skins":["color-play","aurora"]}"""
                "skins/aurora/skin.json" -> newSkin.toString()
                else -> readAsset(path)
            }
        }
        val skin = catalog.get("aurora")
        assertEquals(2, skin.version)
        assertEquals("极光", skin.label("zh"))
        assertEquals("Aurora", skin.label("en"))
        assertEquals("images/banner.png", skin.variant(false).home!!.getJSONObject("futureLayout").getString("image"))
        assertNull(skin.variant(true).home)
    }

    @Test fun parserRejectsUnsupportedSchemaMalformedMetadataAndIncompletePalettes() {
        val cases: List<(JSONObject) -> Unit> = listOf(
            { it.put("schemaVersion", 2) },
            { it.put("schemaVersion", "1") },
            { it.put("id", "../paper") },
            { it.put("version", 0) },
            { it.put("version", "1") },
            { it.getJSONObject("name").put("zh", " ") },
            { it.getJSONObject("variants").getJSONObject("light").put("home", JSONArray()) },
            { it.getJSONObject("variants").getJSONObject("light").getJSONObject("palette").getJSONObject("colors").remove("accent") },
            { it.getJSONObject("variants").getJSONObject("light").getJSONObject("palette").getJSONObject("colors").put("accent", "#fff") },
            { it.getJSONObject("variants").getJSONObject("dark").getJSONObject("palette").getJSONObject("variables").remove("--ms-background") },
        )
        for (change in cases) assertThrows(IllegalArgumentException::class.java) { BuiltinSkin.parse(paper().apply(change)) }
    }

    @Test fun indexRejectsPathTraversalDuplicateIdsAndMissingDefaultBeforeReadingPackages() {
        for (index in listOf(
            """{"schemaVersion":2,"skins":["color-play"]}""",
            """{"schemaVersion":1,"skins":["color-play","../paper"]}""",
            """{"schemaVersion":1,"skins":["color-play","color-play"]}""",
            """{"schemaVersion":1,"skins":["paper","color-play"]}""",
            """{"schemaVersion":1,"skins":[]}""",
        )) {
            var packageRead = false
            assertThrows(IllegalArgumentException::class.java) {
                MobileSkinCatalog.load { path ->
                    if (path == "skins/index.json") index else {
                        packageRead = true
                        readAsset(path)
                    }
                }
            }
            assertFalse(packageRead)
        }
        assertThrows(IllegalArgumentException::class.java) {
            MobileSkinCatalog.load { path ->
                if (path == "skins/index.json") """{"schemaVersion":1,"skins":["color-play"]}"""
                else paper().put("id", "other").toString()
            }
        }
    }
}
