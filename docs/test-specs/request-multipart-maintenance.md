# Legacy request multipart maintenance

Update request's scoped form-data override from 2.5.5 to the patched 2.5.6.
Only that installed package changes; modern Axios consumers retain 4.0.6.
The compatible 2.x patch avoids changing request's stream/multipart contract
while the broader legacy bridge retirement review remains open.

GHSA-hmw2-7cc7-3qxx concerns unescaped quotes and CRLF in multipart field
names and filenames. This is dependency hardening, not a demonstrated
Nightscout exploit: the inspected legacy bridge request upload uses JSON.
See https://github.com/advisories/GHSA-hmw2-7cc7-3qxx.

Three tests resolve request through minimed-connect-to-nightscout and send
real local HTTP requests with proxying disabled. Native Response.formData
independently parses the resulting multipart body. Tests preserve unicode,
binary bytes, file names, content length and streaming values; malicious
field/filename cases cannot inject header lines or extra parts. The ordinary
upload passes on 2.5.5, while both injection cases fail. All three pass on
2.5.6 under Node 22.23.2 and 24.20.0.

Full backend/dependency/build and hosted validation remain merge gates.
There is no schema, UI or deployment setting change. Rollback restores the
scoped override and lockfile together. This does not resolve request's own
maintenance/SSRF risks; M09/M29 remain open for their separate review.
