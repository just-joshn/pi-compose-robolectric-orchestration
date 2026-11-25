# Setting up Robolectric for Compose

Sources: developer.android.com/training/testing/local-tests/robolectric, robolectric.org/getting-started,
robolectric.org/configuring.

```kotlin
android {
  testOptions { unitTests { isIncludeAndroidResources = true } }   // [official]
}
dependencies {
  testImplementation(platform("androidx.compose:compose-bom:<bom>"))
  testImplementation("androidx.compose.ui:ui-test-junit4")
  debugImplementation("androidx.compose.ui:ui-test-manifest")      // needed by createComposeRule [official]
  testImplementation("junit:junit:4.13.2")
  testImplementation("org.robolectric:robolectric:<version>")
}
```

- Any UI test in the `test` source set runs on Robolectric. [official]
- By default Robolectric runs against `targetSdk`. Pin it with `@Config(sdk = [N])` or a
  `robolectric.properties` file (`sdk=N`) under `src/test/resources/<package>/`. [official: configuring]
- `sdk` and `minSdk`/`maxSdk` cannot be combined in one `@Config`. [official: configuring]
- Robolectric downloads `android-all-instrumented` jars for each SDK on first use. Offline CI
  needs them cached. [official: configuring, offline mode]

## Verified version set (this package's fixture, 2026-11-25)

JDK 25.0.5, Gradle 9.8.0, AGP 9.5.3 with built-in Kotlin, Kotlin Compose plugin 2.4.21, Compose
BOM 2026.11.01 (ui-test 1.13.0), Robolectric 4.18.1, `@Config(sdk = [36])`. compileSdk must be
37.2: material3 1.5 and foundation 1.13 AAR metadata reject 36. This is an observed fact, not an
official compatibility matrix.
