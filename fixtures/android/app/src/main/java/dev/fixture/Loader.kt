package dev.fixture

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Loads a value on a background thread, then shows it. */
@Composable
fun Loader(load: () -> String) {
  var value by remember { mutableStateOf("Loading") }
  LaunchedEffect(Unit) { value = withContext(Dispatchers.Default) { load() } }
  Text(value)
}
