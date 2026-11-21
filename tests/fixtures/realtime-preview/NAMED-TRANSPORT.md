# Named actual-role fixture transports

Source-only fixture repair; no product admission, authentication, origin rule or
browser DNS change. The actual pinned `xmlhttprequest-ssl` constructs its Host
header from the request URL after applying extraHeaders. A loopback URL with an
extra named Host therefore sends the loopback Host. A no-listener source protocol
captured actual `http.request` options confirming that mechanism. The earlier
native `xhr poll error` did not preserve an HTTP status, so its exact cause remains
unmeasured until actual role execution.

`roles.client({host,namespace,transports})` constructs the actual Socket.IO client
at the selected named fixture origin and owned ingress port. Its dedicated
`http.Agent` resolves only the exact two configured `.example.test` fixture hosts
to `127.0.0.1`; unknown names and requested IPv6 refuse without system DNS fallback.
The same actual Agent is supplied for polling and websocket clients. No global DNS,
`io.connect`, Host rewriting or API response replacement is used. Fixture close
closes its Node clients and destroys only its own Agent. The independent single
Mongo reference keeps its actual loopback URL; accepted profile-port/differential/
upgrade/wire paths are unchanged. Browser clients retain their reviewed Chromium
resolver and real same-origin ingress.

`transport-diagnostics.json` captures only fixed kind/routeClass/transport/EIO,
HTTP status, knownHost boolean, upstream role and allowlisted errorCode. knownHost
means membership in the synthetic fixture alias list, not authenticated admission.
No full query, sid, token, URL, response/request body, arbitrary header, error
message or credential is stored. HTTP response metadata is recorded before it is
forwarded, client connect-error metadata before caller rejection listeners, and
regular raw files survive parent cleanup. The fixture keeps at most128 recent
events and65536 bytes, with visible droppedEvents; the newest failure is retained.
These are diagnostic storage bounds, not capacity or latency acceptance.

`tests/realtime-named-fixture-transport.test.js` is a unit source protocol. It
intercepts request construction only (no listener/traffic), exercises actual
Socket.IO objects without auto-connect, verifies strict Agent lookups and bounded
redacted metadata. Source controls restore the old loopback URL, permit unknown
lookups and bypass the diagnostic bound; each must make its corresponding source
oracle fail. This does not replace native polling/websocket/current-authority or
browser acceptance. The root campaign must pin both new helper hashes alongside
roles/ingress/active drivers; protected profile27 files and early dispatcher remain
unchanged.
