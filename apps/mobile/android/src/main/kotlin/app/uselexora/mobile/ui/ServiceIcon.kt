package app.uselexora.mobile.ui

import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import app.uselexora.mobile.R

@Composable
internal fun ServiceIcon(modifier: Modifier, tint: Color) {
    Icon(painterResource(R.drawable.ic_service), null, modifier, tint = tint)
}
