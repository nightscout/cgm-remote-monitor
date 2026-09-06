# Native deterministic document identifiers

M08's UUID review found one production call site: calculateIdentifier in API3
operationTools. It needs the existing deterministic v5 identifier, with the
16 ASCII bytes of `NightscoutRocks!` as namespace and the unchanged
`device_date[_eventType]` key. Native randomUUID would change every identifier
and is not suitable.

The implementation follows RFC 9562 section 5.5: hash namespace bytes and UTF-8
name with SHA-1, retain 128 bits, and set the v5/version and UUID variant bits.
SHA-1 here preserves the identifier protocol; these identifiers are not secrets
or password hashes. See https://www.rfc-editor.org/rfc/rfc9562.html#section-5.5.
The namespace, key coercion, optional event type and caller-supplied identifier
handling are unchanged. Lone UTF-16 surrogates still throw URIError: Buffer's
replacement-character encoding would otherwise silently change behavior.

The existing persisted vectors remain, with independent Python uuid.uuid5
vectors for composed/decomposed Unicode, NUL and a 10,000-character name.
Fifteen tests pass on Node 22.23.2 and 24.20.0, including repeat processing and
the historical disabled-require-ESM flag check. A separate 264-case old/native
comparison covers absent/null/empty/numeric/boolean/Unicode/long device values,
varied dates and event types; every identifier matches exactly. The two tests
of the deleted package's output-buffer API are retired with that unused API;
the application's document and error contracts remain covered.

UUID 14.0.2 was reviewed, but the narrow native operation removes the direct
package rather than adding ESM interoperability for a single v5 call. The
lockfile removes one package path with no additions or retained entry changes.
Removed installed regular-file contents total 134,222 bytes. Clean npm ci and
production build pass; all six browser bundles match the DST parent build.
Full API/duplicate-upload/update validation and hosted checks remain required.
No server heap saving is claimed from this file-size measurement.

No database migration or identifier rewrite is allowed. Rollback restores the
UUID declaration/lockfile and prior calculateIdentifier together. Existing
documents and repeated uploads must continue to resolve to the same IDs.
