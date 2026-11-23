package app.uselexora.mobile.ui

import android.content.Context

internal object BuiltinSkins {
    private var catalog: MobileSkinCatalog? = null

    @Synchronized private fun catalog(context: Context): MobileSkinCatalog = catalog ?: MobileSkinCatalog.load { path ->
        context.assets.open(path).bufferedReader().use { it.readText() }
    }.also { catalog = it }

    fun list(context: Context): List<BuiltinSkin> = catalog(context).skins
    fun get(context: Context, id: String): BuiltinSkin = catalog(context).get(id)
    fun current(context: Context): BuiltinSkin = get(context, MobileAppearance.skinId)
}
