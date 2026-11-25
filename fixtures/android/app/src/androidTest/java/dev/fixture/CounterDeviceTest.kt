package dev.fixture

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CounterDeviceTest {
  @get:Rule val rule = createComposeRule()

  @Test
  fun startsAtZero() {
    rule.setContent { Counter() }
    rule.onNodeWithText("Count: 0").assertIsDisplayed()
  }

  @Test
  fun twoClicksShowTwo() {
    rule.setContent { Counter() }
    rule.onNodeWithText("Increment").performClick()
    rule.onNodeWithText("Increment").performClick()
    rule.onNodeWithText("Count: 2").assertIsDisplayed()
  }
}
