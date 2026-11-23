package app.uselexora.mobile.ui

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SkinHomeModelTest {
    private fun home(id: String = "color-play", variant: String = "light"): JSONObject =
        JSONObject(File("../skins/$id/skin.json").readText()).getJSONObject("variants").getJSONObject(variant).getJSONObject("home")

    private fun pathFixture(): JSONObject = home().apply {
        getJSONObject("surfaces").getJSONObject("hero").put("shape", JSONObject("""{
            "type":"path","commands":[{"op":"M","values":[0,0]},{"op":"L","values":[1,0]},
            {"op":"L","values":[1,1]},{"op":"L","values":[0,1]},{"op":"Z","values":[]}]
        }"""))
    }

    @Test fun builtinVariantsKeepAllBusinessSlotsAndPaperOnItsOriginalRoute() {
        val paper = JSONObject(File("../skins/paper/skin.json").readText()).getJSONObject("variants")
        val slots = setOf("background", "header", "service", "space", "hero", "approvals", "questions", "unread", "marked", "all", "settings", "heroAction", "heroIcon", "badge", "allBadge")
        for (mode in listOf("light", "dark")) {
            assertNull(decodeSkinHome(paper.getJSONObject(mode).optJSONObject("home")))
            for (id in listOf("color-play", "mecha-armor")) {
                val model = requireNotNull(decodeSkinHome(home(id, mode), "skins/$id/"))
                assertTrue(model.surfaces.keys.containsAll(slots))
                assertTrue(model.layout.heroMinHeight >= 128f)
                assertTrue(model.layout.shortcutMinHeight >= 48f)
                model.surfaces.values.mapNotNull { it.image }.forEach { assertTrue(it.path.startsWith("skins/$id/")) }
            }
        }
    }

    @Test fun invalidDescriptionsCannotHideActionsOrCreateArbitraryLayouts() {
        assertNull(decodeSkinHome(home().put("schemaVersion", 2)))
        assertNull(decodeSkinHome(home().apply { getJSONObject("surfaces").remove("questions") }))
        assertNull(decodeSkinHome(home().apply { getJSONObject("layout").put("shortcutMinHeight", 0) }))
        assertNull(decodeSkinHome(home().apply { getJSONObject("typography").put("titleSize", 10000) }))
        for (field in listOf("headerFlow", "actionArrangement", "serviceLayout", "spaceVerticalAlignment")) {
            assertNull(decodeSkinHome(home().apply { getJSONObject("layout").put(field, "arbitrary-tree") }))
        }
        assertNull(decodeSkinHome(home().apply { getJSONObject("layout").remove("actionArrangement") }))
        assertNull(decodeSkinHome(home().put("iconStyle", "remote-script")))
    }

    @Test fun pathCoordinatesOperationsAndDecorationBudgetsAreBounded() {
        val outOfBounds = pathFixture()
        outOfBounds.getJSONObject("surfaces").getJSONObject("hero").getJSONObject("shape")
            .getJSONArray("commands").getJSONObject(0).getJSONArray("values").put(0, 1.01)
        assertNull(decodeSkinHome(outOfBounds))
        val unsupportedOperation = pathFixture()
        unsupportedOperation.getJSONObject("surfaces").getJSONObject("hero").getJSONObject("shape")
            .getJSONArray("commands").getJSONObject(1).put("op", "A")
        assertNull(decodeSkinHome(unsupportedOperation))
        val layer = JSONObject("""{"bounds":[0,0,1,1],"shape":{"type":"rounded","radius":1},"fill":{"colors":["#FFFFFF"],"angle":0},"opacity":1}""")
        val tooManyLayers = home()
        tooManyLayers.getJSONObject("surfaces").getJSONObject("background").put("layers", JSONArray().apply { repeat(17) { put(layer) } })
        assertNull(decodeSkinHome(tooManyLayers))
        layer.getJSONArray("bounds").put(2, 3)
        assertNull(decodeSkinHome(home().apply { getJSONObject("surfaces").getJSONObject("background").put("layers", JSONArray().put(layer)) }))
    }

    @Test fun connectedArtworkAllowsZeroGuttersAndLargeTextStillStacks() {
        val model = requireNotNull(decodeSkinHome(home().apply {
            getJSONObject("layout").put("pageInset", 0).put("gap", 0).put("headerFlow", "inline")
                .put("serviceWidth", .6).put("spaceWidth", .5)
        }))
        assertEquals(0f, model.layout.pageInset, 0f)
        assertEquals(0f, model.layout.gap, 0f)
        assertFalse(model.layout.stackActions(360f, 1f))
        assertTrue(model.layout.stackActions(320f, 1.5f))
        assertFalse(model.layout.stackHeader(360f, 1f))
        assertTrue(model.layout.stackHeader(320f, 1.5f))
        val (service, space) = model.layout.inlineWidths()
        assertEquals(1f, service + space, .0001f)
        assertTrue(service > space)
    }

    @Test fun heroRegionsNeverOverlapAndGrowToFitNativeContent() {
        val document = home().apply {
            getJSONObject("layout").put("heroPromptBounds", JSONArray("[0.15,0.1,0.7,0.2]"))
                .put("heroActionBounds", JSONArray("[0.1,0.4,0.8,0.4]"))
        }
        val layout = requireNotNull(decodeSkinHome(document)).layout
        val height = layout.heroHeight(72f, 120f)
        assertTrue(height * layout.heroPromptBounds.height >= 72f)
        assertTrue(height * layout.heroActionBounds.height >= 120f)
        assertTrue(height >= layout.heroMinHeight)
        document.getJSONObject("layout").put("heroActionBounds", JSONArray("[0.1,0.2,0.8,0.4]"))
        assertNull(decodeSkinHome(document))
        document.getJSONObject("layout").put("heroActionBounds", JSONArray("[0.5,0.4,0.8,0.4]"))
        assertNull(decodeSkinHome(document))
    }

    @Test fun contentRegionsAndTypeHierarchyRemainBoundedAndIndependent() {
        val document = home("mecha-armor")
        val model = requireNotNull(decodeSkinHome(document))
        assertTrue(model.layout.brandIconSize > model.typography.brandSize)
        assertTrue(model.typography.titleWeight > model.typography.weight)
        assertTrue(model.layout.spaceContentBounds.x > .1f)
        assertTrue(model.layout.spaceContentBounds.x + model.layout.spaceContentBounds.width < .95f)
        for (field in listOf("serviceContentBounds", "spaceContentBounds")) {
            assertNull(decodeSkinHome(home().apply { getJSONObject("layout").put(field, JSONArray("[0.9,0.1,0.5,0.5]")) }))
        }
        assertNull(decodeSkinHome(home().apply { getJSONObject("layout").put("brandIconSize", 1000) }))
        assertNull(decodeSkinHome(home().apply { getJSONObject("typography").put("titleWeight", 1000) }))
        document.getJSONObject("typography").remove("titleWeight")
        assertEquals(model.typography.weight, requireNotNull(decodeSkinHome(document)).typography.titleWeight)
    }

    @Test fun shortcutContentInsetsKeepDefaultsAndValidateEachEdge() {
        val document = home().apply { getJSONObject("layout").remove("shortcutPadding") }
        assertEquals(SkinInsets(28f, 10f, 28f, 10f), requireNotNull(decodeSkinHome(document)).layout.shortcutPadding)
        document.getJSONObject("layout").put("shortcutPadding", JSONArray("[42,10,28,10]"))
        assertEquals(SkinInsets(42f, 10f, 28f, 10f), requireNotNull(decodeSkinHome(document)).layout.shortcutPadding)
        for (invalid in listOf("[-1,10,28,10]", "[42,10,65,10]", "[42,10,28]")) {
            document.getJSONObject("layout").put("shortcutPadding", JSONArray(invalid))
            assertNull(decodeSkinHome(document))
        }
    }

    @Test fun heroAspectRatioAdaptsToWidthWithoutClippingNativeText() {
        val document = home().apply { getJSONObject("layout").put("heroMinHeight", 128).put("heroAspectRatio", 2) }
        val layout = requireNotNull(decodeSkinHome(document)).layout
        assertEquals(160f, layout.heroHeight(0f, 0f, 320f), .001f)
        assertEquals(195f, layout.heroHeight(0f, 0f, 390f), .001f)
        assertEquals(128f, layout.heroHeight(0f, 0f, 200f), .001f)
        assertTrue(layout.heroHeight(90f, 120f, 320f) * layout.heroPromptBounds.height >= 90f)
        for (ratio in listOf(0, .01, 4.1)) {
            document.getJSONObject("layout").put("heroAspectRatio", ratio)
            assertNull(decodeSkinHome(document))
        }
        document.getJSONObject("layout").remove("heroAspectRatio")
        assertEquals(128f, requireNotNull(decodeSkinHome(document)).layout.heroHeight(0f, 0f, 390f), .001f)
    }

    @Test fun imagesAndFontsResolveOnlyWithinTheSelectedBuiltinPackage() {
        val document = home().apply {
            getJSONObject("surfaces").getJSONObject("hero").put("image", JSONObject("""{"path":"images/hero.webp","insets":[12,24,12,24]}"""))
            getJSONObject("typography").put("fontFamily", "fonts/body.ttf").put("brandFontFamily", "fonts/brand.otf").put("brandItalic", true)
        }
        val model = requireNotNull(decodeSkinHome(document, "skins/color-play/"))
        assertEquals("skins/color-play/images/hero.webp", model["hero"].image?.path)
        assertEquals(listOf(12, 24, 12, 24), model["hero"].image?.insets)
        assertEquals("skins/color-play/fonts/body.ttf", model.typography.fontFamily)
        assertTrue(model.typography.brandItalic)
        assertNull(decodeSkinHome(document, "skins/../"))
        for (path in listOf("../hero.webp", "images/../../hero.webp", "/hero.webp", "images\\hero.webp", "https://example.com/hero.webp", "images/%2e%2e/hero.webp", "images//hero.webp", "images/hero.svg")) {
            document.getJSONObject("surfaces").getJSONObject("hero").getJSONObject("image").put("path", path)
            assertNull(path, decodeSkinHome(document, "skins/color-play/"))
        }
    }

    @Test fun nineSliceCoversTheDestinationAndPreservesCornerAspectRatio() {
        val patches = skinImagePatches(100, 100, 200, 300, listOf(10, 20, 10, 20))
        assertEquals(9, patches.size)
        assertEquals(60_000, patches.sumOf { it.dw * it.dh })
        assertEquals(SkinImagePatch(0, 0, 10, 20, 0, 0, 20, 40), patches.first())
        assertEquals(SkinImagePatch(10, 20, 80, 60, 20, 40, 160, 220), patches[4])
        for (patch in skinImagePatches(100, 100, 3, 2, listOf(20, 20, 20, 20))) {
            assertTrue(patch.dx >= 0 && patch.dy >= 0 && patch.dx + patch.dw <= 3 && patch.dy + patch.dh <= 2)
        }
        assertTrue(runCatching { skinImagePatches(100, 100, 200, 300, listOf(50, 0, 50, 0)) }.isFailure)
        assertTrue(runCatching { skinImagePatches(100, 100, 200, 300, listOf(-1, 0, 0, 0)) }.isFailure)
        assertEquals(listOf(SkinImagePatch(0, 0, 100, 100, 0, 0, 200, 300)), skinImagePatches(100, 100, 200, 300, null))
    }

    @Test fun rgbaColorsPreserveAlphaAndRejectNonColorInputs() {
        assertEquals(0xFF123456L, "#123456".skinColor())
        assertEquals(0x80123456L, "#12345680".skinColor())
        assertEquals(0L, "#00000000".skinColor())
        for (value in listOf("red", "#fff", "url(file:///tmp/pixel)", "#123456789")) assertTrue(runCatching { value.skinColor() }.isFailure)
    }
}
