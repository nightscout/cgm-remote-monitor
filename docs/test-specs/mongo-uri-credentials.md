# MongoDB credential URI parsing (M21)

Nightscout uses URI credentials only to warn when the database password equals
API_SECRET. `lib/utils/mongo-password-matches.js` now uses the public
`mongodb-connection-string-url` parser already installed for MongoDB 5.9.2.
Its username/password properties use URL encoding, so the comparison explicitly
decodes the password. Multi-host, IPv6 and SRV grammar stay with the MongoDB
parser; this is not a generic Node URL replacement.

The parser's public API is documented in its installed README and
[upstream repository](https://github.com/mongodb-js/mongodb-connection-string-url).
A direct declaration pins the same 3.0.2 already required by the driver's
override. One legacy installed package disappears, but the number of direct
declarations does not decrease. No runtime-memory saving is claimed.

An initial MongoClient-based approach was rejected: the installed 5.9 driver
reads TLS files in its constructor. The dedicated parser creates no client,
reads no TLS files and performs no network connection or SRV lookup. Connection
option validation stays with the driver at connection setup, as before. URI
syntax validation now follows the maintained driver parser and accepts modern
options such as SCRAM-SHA-256 that the legacy parser rejected.

`tests/mongo-uri-credentials.test.js` covers multi-host, SRV, IPv6, encoded and
absent credentials, modern options, malformed URIs, nonexistent TLS file paths,
no connect calls, and matching/nonmatching password warnings on successive
real environment configurations. With the existing env suite, 34 focused tests
pass on Node 22. Clean install/build, Node 24, full backend and hosted validation
remain required before merge.
