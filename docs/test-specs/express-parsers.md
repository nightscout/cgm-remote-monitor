# Express parser ownership (M20)

Application code uses Express's public json, urlencoded, raw and text parsers.
The middleware bundle retains its bodyParser property as an object of these
four functions so existing routes keep their options and registration order.
Notifications, API v3 and CSP reports now call Express directly. The Alexa
fixture replaces the deprecated combined parser with its JSON and extended
URL-encoded components, retaining the 50 MiB fixture limit.

The existing dependency compatibility suite verifies that Express exposes the
same functions as its installed body-parser dependency. Its 29 cases exercise
limits, inherited-option protection, compression, malformed bodies and route
contracts through the public Express parsers. The dependency oracle resolves
body-parser relative to Express instead of relying on a hoisted direct import.

Removing the root declaration changes no installed lock entries. Body-parser
remains an Express dependency; this change claims no package-size or runtime
memory saving. The package remains covered by dependency compatibility checks.

Initial Node 22 focused validation: 29 passing, lint with no errors and six
existing filesystem warnings in the server app. Clean install/build, full
backend validation and hosted CI are required before merge. No user-facing
behavior or configuration change is intended.
