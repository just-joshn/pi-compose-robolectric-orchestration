package dev.fixture

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import kotlin.random.Random
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class LoaderTest {
  @get:Rule val rule = createComposeRule()

  @Test
  fun showsLoadedValue() {
    rule.setContent {
      Loader {
        Thread.sleep(Random.nextLong(0, 400))
        "Ready"
      }
    }
    Thread.sleep(200)
    rule.onNodeWithText("Ready").assertIsDisplayed()
  }
}
