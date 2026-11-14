package app.uselexora.mobile.ui

import android.content.Context
import app.uselexora.mobile.i18n.MobileStrings
import com.journeyapps.barcodescanner.CaptureActivity

class PairingCaptureActivity : CaptureActivity() {
    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(MobileStrings.localizedContext(base))
    }
}
