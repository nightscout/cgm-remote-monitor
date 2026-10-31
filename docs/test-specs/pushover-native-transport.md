# Native Pushover transport (M09)

Remove `pushover-notifications` 1.2.3 and replace the application's used subset
with `lib/server/pushover-client.js`, using Node HTTPS and URLSearchParams.
Nightscout uses message submission and receipt cancellation; it does not use the
SDK's attachments, custom proxy, sound enumeration or scheduled sound refresh.
No replacement dependency or public endpoint override is added.

The [message API](https://pushover.net/api) supports URL-encoded HTTPS POSTs,
and [receipt cancellation](https://pushover.net/api/receipts) specifies POST.
TLS verification stays enabled and the production origin is fixed. The helper
has a ten-second total request deadline and a 64 KiB response limit. It does
not follow redirects or automatically retry a POST: a timeout can occur after
a message was accepted, so retrying could duplicate a notification.

## Preserved and corrected behavior

- Existing user/group/alarm/announcement routing, disabled-key fallback, sound,
  priority, retry, 15-minute expiration and callback URLs remain unchanged.
  Each recipient's form is encoded synchronously without mutating the shared
  message. Normal priority is explicitly sent as 0 rather than omitted; both
  mean normal priority in the API.
- Successful send callbacks retain JSON text, which `pushnotify` parses to
  store receipts and extend suppression TTLs. Cancellation retains the response
  object/statusCode callback shape after consuming its response.
- Cancellation now uses the documented POST method with the token in the body,
  rather than GET with a token in the URL. The receipt path segment is encoded.
- HTTP failures, API status 0, malformed JSON, interrupted/oversized responses,
  TLS failures and timeouts invoke the error callback once. The previous SDK
  could log an API error but still invoke the send callback as a success;
  cancellation previously treated an HTTP error response as success. Failures
  now preserve existing retryable receipt-cache behavior.
- Message timestamps now use Unix seconds from the server clock. The previous
  Date object serialized to an empty form value. This makes the existing
  creation-time intent explicit; operators should keep the server clock correct.
- Newly created errors contain stable categories and HTTP status where useful,
  not raw response bodies, tokens or request objects. Existing application
  logging policy is otherwise unchanged.

No configuration migration is required. This intentionally corrects protocol
and failure handling; it is not a claim of byte-identical wire requests.

## Verification

`tests/pushover-transport.test.js` uses generated certificates and an owned HTTPS
fixture with TLS verification enabled. The fixture redirects requests only in
the test loader; no real Pushover account or device is contacted. It checks:

- Unicode/form encoding, independent simultaneous recipients and unchanged
  input objects; actual plugin recipient routing, alarm fields and timestamps.
- Raw JSON receipt results and POST cancellation with body credentials.
- HTTP 400/429/503, redirects, API failure, malformed/oversized/truncated responses,
  deadlines and untrusted certificates, with exactly one completion and no retry.
- Repeated send/cancel calls and owned request socket cleanup. The fixture uses
  a non-pooled agent; production retains Node's normal shared HTTPS agent policy.

Existing plugin/lifecycle and notification-cache tests retain recipient selection,
suppression, acknowledgement, cancellation and teardown coverage. The provider
measurement tool recognizes both the old SDK and new native client, preserving
its interception of all outbound sends. New checks use existing CI environments.
These tests do not establish live vendor/device delivery or account validity.

## Measured footprint

The removed SDK's regular files total 26,270 bytes. The net runtime source
increase is 3,695 bytes, so package plus runtime source decreases by 22,575 bytes
(excluding test/documentation files and filesystem allocation). One production
package path is removed. All six generated browser JavaScript bundles are
byte-for-byte unchanged from the APNs candidate. No measured server RAM,
Docker-image or browser-transfer saving is claimed.
