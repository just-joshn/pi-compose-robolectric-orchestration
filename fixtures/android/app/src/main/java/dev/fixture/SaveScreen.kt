package dev.fixture

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import kotlinx.coroutines.launch

fun interface NoteRepository {
  suspend fun save(text: String): Boolean
}

/** Saves the note when Save is clicked and reports the result. */
@Composable
fun SaveScreen(repository: NoteRepository, note: String = "draft") {
  val scope = rememberCoroutineScope()
  var status by remember { mutableStateOf("idle") }
  Column {
    Text("Status: $status")
    Button(
      onClick = {
        scope.launch { status = if (repository.save(note)) "saved" else "failed" }
      },
    ) {
      Text("Save")
    }
  }
}
