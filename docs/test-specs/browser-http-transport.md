# Intercepted browser fixture transport

The common browser fixture permits only its exact disposable loopback origin.
It fetches responses with maxRedirects: 0 before fulfilling them, so an allowed
fixture URL cannot redirect a test to an external server. Service workers are
blocked in this fixture; the separate worker suite uses its own native harness.

Hosted report failures appeared in Chromium, Firefox and WebKit. Diagnostics
captured browser requests stalled inside route.fetch for about 15 seconds,
with no corresponding unfinished server response. In the WebKit capture all
five routed requests were still in the fetch phase. Playwright's installed
transport uses a keep-alive agent.

The candidate mitigation sends Connection: close for intercepted fixture
fetches, while retaining all original request headers, the five-second fetch
timeout and redirect restrictions. This gives requests independent connections;
it does not change production HTTP behavior or the native service-worker suite.
The report stall assertion remains 15 seconds with a 60-second total limit.

Local validation: ten repetitions of the two complete report tests pass with
this setting (20 cases, 58 seconds), and all three browser isolation tests pass,
including blocked redirects and external requests. The same stress run also
passed before the change, so local success does not establish causality. Full
WebKit and hosted cross-browser validation remain required. The retained phase
diagnostics must be inspected if another stall occurs; this is not yet a proven
resolution of the hosted failure.
