# Client startup recovery

M15's page-loading work depends on preserving each page's initialization callback when server settings are not immediately available. `client.init(callback)` previously dropped that callback when the server was still loading. Its offline path called init immediately while constructing a timeout, causing immediate retry attempts and also losing the callback.

Both paths now schedule a closure that calls `client.init(callback)` after five seconds. Authentication completion still retries immediately with the same callback; only its ineffective timeout wrapper is removed. Successful initialization, status/auth endpoints, displayed messages, stored data and settings remain unchanged.

`tests/browser/startup-retries.test.js` loads the production bundle in a real browser and exercises:

- Two loading responses followed by success, repeated for two initialization cycles.
- Two aborted status requests followed by success, repeated for two cycles.
- A 401 response, authentication completion and successful retry, repeated for two cycles.

Browser clocks prove no attempt occurs at 4,999 milliseconds and exactly one occurs at 5,000 for loading/offline recovery. Real HTTP/AJAX completion remains asynchronous. Each callback updates visible page output once, and advancing ten further seconds verifies no stale retry remains. Authentication preserves its immediate retry behavior.

The test intercepts the downstream language/page loader and authentication-completion boundary, so it establishes retry timing and callback forwarding; it does not claim to boot all page templates. Existing authentication tests cover native controls, and the full page startup/auth/reconnect/offline/HMR requirements remain part of M15.

The unchanged parent fails the loading and offline cases and passes authentication. The candidate passes all three cases in Chromium and WebKit. These cases join the required six-job browser matrix. No dependency change or memory-saving claim belongs to this prerequisite fix. Rollback restores `lib/client/index.js`; the regressions will then fail again.
