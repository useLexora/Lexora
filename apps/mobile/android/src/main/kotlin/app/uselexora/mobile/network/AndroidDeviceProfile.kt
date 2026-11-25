package app.uselexora.mobile.network

import android.os.Build
import org.json.JSONObject

internal fun androidDeviceName(): String = profileText(Build.MODEL) ?: "Android"

internal fun androidDeviceProfile(version: String) = JSONObject()
    .put("platform", "android")
    .put("manufacturer", profileText(Build.MANUFACTURER))
    .put("model", profileText(Build.MODEL))
    .put("osVersion", profileText(Build.VERSION.RELEASE))
    .put("appVersion", version)

private fun profileText(value: String?): String? = value
    ?.filterNot { it.isISOControl() || Character.getType(it) == Character.FORMAT.toInt() }
    ?.trim()
    ?.take(80)
    ?.takeUnless { it.isBlank() || it.equals(Build.UNKNOWN, ignoreCase = true) }
