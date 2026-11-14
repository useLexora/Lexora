package app.uselexora.mobile.session

import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.network.ProductClient
import java.util.concurrent.Executor

data class MobileOperationOwner(val partition: String, val topic: String, val inputScope: String, val visit: Long, val connectionGeneration: Long, val connection: ProductClient? = null, val view: String = "")

data class MobileOperationFailure(val code: String?, val cause: Throwable) {
    companion object {
        fun from(error: Throwable): MobileOperationFailure {
            val causes = generateSequence(error) { it.cause }.take(12).toList()
            val code = causes.filterIsInstance<ProtocolFailure>().firstOrNull()?.code ?: when {
                causes.any { it is javax.net.ssl.SSLPeerUnverifiedException || it is java.security.cert.CertificateException } -> "TLS_IDENTITY_MISMATCH"
                causes.any { it is java.io.IOException || it is java.util.concurrent.TimeoutException } -> "SERVICE_UNREACHABLE"
                else -> null
            }
            return MobileOperationFailure(code, error)
        }
    }
}

class MobileOperations(
    private val executor: Executor,
    private val owner: () -> MobileOperationOwner,
    private val dispatch: (() -> Unit) -> Unit,
    private val alive: () -> Boolean,
    private val failed: (MobileOperationFailure) -> Unit,
) {
    fun execute(operation: () -> Unit) {
        val captured = owner()
        executor.execute {
            try { operation() }
            catch (error: Exception) {
                val failure = MobileOperationFailure.from(error)
                dispatch { if (alive() && owner() == captured) failed(failure) }
            }
        }
    }
}
