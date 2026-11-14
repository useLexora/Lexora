package app.uselexora.mobile

import android.app.Application
import app.uselexora.mobile.ui.MobileAppearance
import app.uselexora.mobile.i18n.MobileStrings

class MobileApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        MobileStrings.initialize(this)
        if (android.os.Process.myUid() == applicationInfo.uid) MobileAppearance.load(this)
    }
}
