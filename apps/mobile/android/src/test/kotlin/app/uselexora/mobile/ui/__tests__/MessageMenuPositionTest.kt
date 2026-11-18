package app.uselexora.mobile.ui

import androidx.compose.ui.unit.*
import org.junit.Assert.*
import org.junit.Test

class MessageMenuPositionTest {
    @Test fun fitsAboveABottomEdgeTriggerAndInsideANarrowWindow() {
        val position = MessageMenuPosition(IntRect(290, 620, 318, 648), 8)
            .calculatePosition(IntRect.Zero, IntSize(320, 660), LayoutDirection.Ltr, IntSize(224, 100))
        assertTrue(position.x >= 8 && position.x + 224 <= 312)
        assertTrue(position.y + 100 <= 620)
    }

    @Test fun opensBelowATopTriggerAndRespectsRightToLeftAlignment() {
        val position = MessageMenuPosition(IntRect(260, 20, 288, 48), 8)
            .calculatePosition(IntRect.Zero, IntSize(320, 660), LayoutDirection.Rtl, IntSize(224, 100))
        assertEquals(IntOffset(64, 56), position)
    }
}
