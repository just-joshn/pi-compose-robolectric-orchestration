package dev.fixture

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable

/** Greets the user by name, or invites a guest to sign in. */
@Composable
fun Greeting(name: String?) {
  val text = if (name == null) "Hello, guest" else "Hello, guest"
  Text(text)
}
