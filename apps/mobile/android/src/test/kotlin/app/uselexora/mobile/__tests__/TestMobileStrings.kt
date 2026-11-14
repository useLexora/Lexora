package app.uselexora.mobile

import app.uselexora.mobile.i18n.MobileStringResources
import app.uselexora.mobile.i18n.MobileStrings
import java.io.File
import java.util.Locale
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element

internal object TestMobileStrings : MobileStringResources {
    private val catalogs = listOf("en" to "values", "zh" to "values-zh").associate { (language, directory) ->
        language to DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File("src/main/res/$directory/strings.xml"))
            .documentElement.childNodes.let { nodes -> (0 until nodes.length).mapNotNull { nodes.item(it) as? Element }.associateBy { it.getAttribute("name") } }
    }
    private val strings = R.string::class.java.fields.associate { it.getInt(null) to it.name }
    private val plurals = R.plurals::class.java.fields.associate { it.getInt(null) to it.name }
    fun install(language: String = "zh") { MobileStrings.initialize(this); MobileStrings.language = language }
    private fun format(text: String, language: String, arguments: Array<out Any?>): String {
        val decoded = text.replace("\\n", "\n").replace("\\'", "'").replace("\\\"", "\"")
        return String.format(Locale.forLanguageTag(language), decoded, *arguments)
    }
    override fun text(id: Int, language: String, arguments: Array<out Any?>): String = format(catalogs.getValue(language).getValue(strings.getValue(id)).textContent, language, arguments)
    override fun quantity(id: Int, language: String, count: Int, arguments: Array<out Any?>): String {
        val items = catalogs.getValue(language).getValue(plurals.getValue(id)).getElementsByTagName("item")
        val key = if (language == "en" && count == 1) "one" else "other"
        val text = (0 until items.length).map { items.item(it) as Element }.first { it.getAttribute("quantity") == key }.textContent
        return format(text, language, arguments)
    }
}
