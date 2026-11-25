package dev.fixture

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class LegacyCounterTest {
  @get:Rule val rule = createComposeRule()

  @Test
  fun clickingIncrementDoesNotCrash() {
    rule.setContent { Counter() }
    rule.onNodeWithText("Increment").performClick()
    Thread.sleep(100)
  }
}
