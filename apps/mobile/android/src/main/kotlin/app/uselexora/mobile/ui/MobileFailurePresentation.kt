package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import app.uselexora.mobile.session.MobileOperationFailure

object MobileFailurePresentation {
    val NETWORK_UNAVAILABLE_NOTICE get() = mobileText(R.string.error_service_unreachable)
    fun message(failure: MobileOperationFailure): String = when (failure.code) {
        "COMMAND_RESULT_UNKNOWN" -> mobileText(R.string.error_command_result_unknown)
        "DATA_GENERATION_CHANGED" -> mobileText(R.string.error_data_generation_changed)
        "NOT_CONNECTED" -> mobileText(R.string.error_not_connected)
        "INVALID_ENDPOINT" -> mobileText(R.string.error_invalid_endpoint)
        "INVALID_PAIRING_CODE" -> mobileText(R.string.error_invalid_pairing_code)
        "PAIRING_EXPIRED", "PAIRING_UNAVAILABLE", "RECOVERY_CLOSED" -> mobileText(R.string.error_pairing_expired)
        "TLS_IDENTITY_MISMATCH" -> mobileText(R.string.error_tls_identity_mismatch)
        "NOT_AUTHORIZED" -> mobileText(R.string.error_not_authorized)
        "PROTOCOL_INCOMPATIBLE" -> mobileText(R.string.error_protocol_incompatible)
        "REVIEW_CHANGED", "REVIEW_REQUIRED", "APPROVAL_ALREADY_RESOLVED" -> mobileText(R.string.error_review_changed)
        "QUESTION_ALREADY_RESOLVED", "QUESTION_NOT_PENDING", "QUESTION_CLOSED" -> mobileText(R.string.error_question_already_resolved)
        "QUESTION_NOT_FOUND", "QUESTION_STALE", "QUESTION_SCOPE_MISMATCH", "QUESTION_BRANCH_CHANGED" -> mobileText(R.string.error_question_not_found)
        "QUESTION_ANSWER_INVALID", "QUESTION_INVALID_ANSWER", "QUESTION_RESPONSE_INVALID" -> mobileText(R.string.error_question_answer_invalid)
        "QUEUE_CHANGED" -> mobileText(R.string.error_queue_changed)
        "INPUT_DELIVERY_TARGET_UNAVAILABLE", "INPUT_DELIVERY_INCOMPATIBLE" -> mobileText(R.string.error_input_delivery_target_unavailable)
        "SERVICE_INSTANCE_CHANGED" -> mobileText(R.string.error_service_instance_changed)
        "LOCAL_DRAFT_DIRTY" -> mobileText(R.string.error_local_draft_dirty)
        "DRAFT_CONFLICT", "SOURCE_CHANGED" -> mobileText(R.string.error_draft_conflict)
        "SERVICE_UNREACHABLE" -> NETWORK_UNAVAILABLE_NOTICE
        "FILE_TOO_LARGE" -> mobileText(R.string.error_file_too_large)
        "LOCAL_CACHE_FULL" -> mobileText(R.string.error_local_cache_full)
        "LOCAL_FILE_FAILED" -> mobileText(R.string.error_local_file_failed)
        "LOCAL_FILE_IN_USE" -> mobileText(R.string.error_local_file_in_use)
        "DOCUMENT_SAVE_FAILED" -> mobileText(R.string.error_document_save_failed)
        "UPLOAD_ALREADY_ADOPTED" -> mobileText(R.string.error_upload_already_adopted)
        "RESOURCE_UNAVAILABLE", "OBJECT_DELETED" -> mobileText(R.string.error_resource_unavailable)
        "UPLOAD_CONFLICT", "CONTENT_HASH_MISMATCH" -> mobileText(R.string.error_upload_conflict)
        "LOCAL_STORAGE_FAILED" -> mobileText(R.string.error_local_storage_failed)
        "FILE_TYPE_UNSUPPORTED" -> mobileText(R.string.error_file_type_unsupported)
        "METHOD_NOT_AVAILABLE" -> mobileText(R.string.error_method_not_available)
        "DESKTOP_UNAVAILABLE" -> mobileText(R.string.error_desktop_unavailable)
        "CONTENT_UNSUPPORTED" -> mobileText(R.string.error_content_unsupported)
        else -> mobileText(R.string.error_unknown)
    }
}
