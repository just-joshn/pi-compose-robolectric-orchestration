plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = "dev.fixture"
  compileSdk { version = release(37) { minorApiLevel = 2 } }
  defaultConfig {
    applicationId = "dev.fixture"
    minSdk = 24
    targetSdk = 36
  }
  buildFeatures { compose = true }
  testOptions { unitTests { isIncludeAndroidResources = true } }
}

dependencies {
  val bom = platform("androidx.compose:compose-bom:2026.11.01")
  implementation(bom)
  implementation("androidx.compose.material3:material3")
  implementation("androidx.activity:activity-compose:1.12.0")
  testImplementation(bom)
  testImplementation("androidx.compose.ui:ui-test-junit4")
  debugImplementation("androidx.compose.ui:ui-test-manifest")
  testImplementation("junit:junit:4.13.2")
  testImplementation("org.robolectric:robolectric:4.18.1")
  androidTestImplementation(bom)
  androidTestImplementation("androidx.compose.ui:ui-test-junit4")
  androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
