package dev.fixture

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class GreetingTest {
  @get:Rule val rule = createComposeRule()

  @Test
  fun guestIsInvited() {
    rule.setContent { Greeting(name = null) }
    rule.onNodeWithText("Hello, guest").assertIsDisplayed()
  }

  @Test
  fun namedUserIsGreetedByName() {
    rule.setContent { Greeting(name = "Ada") }
    rule.onNodeWithText("Hello, Ada").assertIsDisplayed()
  }
}
