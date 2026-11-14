package app.uselexora.mobile.ui

import android.app.AlertDialog
import android.view.ViewGroup
import android.view.WindowManager

internal fun AlertDialog.expandForMobileReview() {
    window?.apply {
        setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    }
}
