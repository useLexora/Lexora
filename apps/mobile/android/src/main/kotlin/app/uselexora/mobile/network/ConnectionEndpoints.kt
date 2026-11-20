package app.uselexora.mobile.network

import app.uselexora.mobile.protocol.ProtocolFailure
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeoutException

internal fun connectionEndpoint(value: String): String {
    val uri = try { URI(value.trim()) } catch (error: Exception) { throw ProtocolFailure("INVALID_ENDPOINT", error) }
    if (uri.scheme != "https" || uri.host.isNullOrEmpty() || uri.userInfo != null || uri.rawQuery != null || uri.rawFragment != null || !(uri.path.isNullOrEmpty() || uri.path == "/") || (uri.port != -1 && uri.port !in 1..65535)) throw ProtocolFailure("INVALID_ENDPOINT")
    return uri.toASCIIString().trimEnd('/')
}

internal fun JSONObject.connectionEndpoints(): List<String> =
    listOfNotNull(getString("endpoint"), optString("alternateEndpoint").takeIf(String::isNotEmpty))
        .map(::connectionEndpoint).distinct()

internal fun JSONArray.serviceEndpoints(): List<String> {
    if (length() !in 1..2) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
    return (0 until length()).map { connectionEndpoint(getString(it)) }.distinct()
}

internal fun JSONObject.saveEndpoints(endpoint: String, available: List<String>): JSONObject = apply {
    put("endpoint", endpoint)
    val alternate = available.firstOrNull { it != endpoint }
    if (alternate == null) remove("alternateEndpoint") else put("alternateEndpoint", alternate)
}

internal fun <T> tryConnectionEndpoints(endpoints: List<String>, connect: (String) -> T): T {
    var failure: Exception? = null
    for (endpoint in endpoints) {
        try { return connect(endpoint) } catch (error: Exception) {
            val cause = if (error is ExecutionException) error.cause else error
            val retryable = cause is IOException || cause is TimeoutException ||
                cause is ProtocolFailure && cause.code in setOf("SERVICE_UNREACHABLE", "TLS_IDENTITY_MISMATCH")
            if (!retryable) throw error
            if (failure == null) failure = error
        }
    }
    throw failure ?: ProtocolFailure("SERVICE_UNREACHABLE")
}
