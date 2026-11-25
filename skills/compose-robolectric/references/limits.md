# When a device or emulator test is still required

From developer.android.com/training/testing/local-tests/robolectric and robolectric.org/best-practices:

- Robolectric does not have a real screen. Pixel-exact screenshots are lower fidelity. [official]
- Some APIs are only partially supported. [official]
- Android libcore differs from OpenJDK, for example time zone parsing with `Z` and `MMM` month
  names. [official: best-practices]
- Not covered: real GPU rendering, performance and jank, hardware sensors, camera, system UI and
  other apps, and real multi-process behavior. These need instrumented tests. [judgment derived
  from the above]
