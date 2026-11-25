# Test performance

- The first Robolectric test in a JVM pays SDK and sandbox startup. Later tests in the same JVM
  reuse it. Splitting tests across many forks multiplies that cost.
  [judgment from Robolectric's documented sandbox model; measure before changing]
- Running many SDK levels (`@Config(sdk = [...])`) multiplies runtime. Keep multi-SDK runs for
  behavior that differs by SDK. [official: configuring, judgment]
- Prefer the virtual clock over real waits. A `waitUntil` that times out costs its whole timeout.
  [official: synchronization]
- `runWithoutImplicitWait` speeds up frame-by-frame animation loops only. [official: synchronization]
- Gradle levers: `maxParallelForks`, `forkEvery`, and the configuration and build caches.
  [gradle docs; judgment per project]

The performance workflow measures median test time before and after in code, requires every
baseline test to still pass, and needs a minimum speedup (default 5%).
