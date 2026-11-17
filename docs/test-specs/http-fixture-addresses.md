# HTTP fixture address families

Supertest starts unbound fixture servers with listen(0), but its serverAddress
implementation constructs an IPv4 loopback URL regardless of the bound family.
An IPv6 wildcard listener and a separate IPv4 listener can own the same port.
A local deterministic probe bound both and showed a request intended for the
IPv6 fixture returning the IPv4 fixture's 405 response instead.

The root test hooks now install an idempotent, test-only Supertest adapter:
when the server is bound to IPv6 wildcard (::), use [::1] in the generated URL.
Explicitly bound IPv4 fixtures retain their URLs. API fixture factories also
choose their loopback address from the bound server family rather than relying
on localhost address selection. Production listeners and request code do not
change. The adapter wraps Supertest's serverAddress method, so its regression
test must accompany future Supertest upgrades.

`tests/supertest-loopback.test.js` places two servers on the same numeric port,
then verifies two consecutive requests reach only the intended IPv6 fixture.
It also verifies explicit IPv4 handling. Both cases pass on Node 22.23.2 and
24.20.0. The full backend and hosted suites are required before integration.

This proves a cause of wrong-fixture HTTP responses, consistent with earlier
local 401/405 and socket-hang-up anomalies. It does not prove that every earlier
failure had this cause, and it does not address the separate intercepted
Firefox report-request stall.
