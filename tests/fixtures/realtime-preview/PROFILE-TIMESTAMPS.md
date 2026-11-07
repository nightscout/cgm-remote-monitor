# Profile differential timestamp oracle

The ad3 native run stored one record on each backend, then stopped on separately
generated top-level dates. Its raw failure is retained unchanged; later cases
were not measured. This correction changes fixture observation/transport only,
not product code, producer profile requests, ports, stored payload expectations
or first-match selection.

Actual canonical socket path: socket-write-handlers.prepareDbAddDocument stamps
missing created_at before EVERY dbAdd (233–239), then SOCKET_ADD.profile default
onExact replaced (write-intent3046, write-settings169–171). Replacement therefore
gets the newly prepared value on retry and selected preseed match. The generic
profileIdFirst new-insert branch at2155 is not the controlling socket path. Source
protocol test invokes the actual canonical handler on an existing profile and
proves regeneration and received-copy mutation. No forced created_at carry rule.
Server srvCreated carry and reply/storage equality remain independently checked.

Each backend call now gets an isolated received copy, matching Socket.IO/private
JSON transport; in-process canonical mutation cannot contaminate the next retry's
producer request. Original JSON remains unchanged and is captured before each
operation, together with prior raw rows, each backend's Date.now call-start/end,
actual raw callbacks and independent physical rows, BEFORE assertions.

Only the uniquely returned/written target's TOP-LEVEL created_at can differ across
backends, and only if original producer lacks that own property. It must exist,
be canonical valid ISO, and fall in its own observed operation window on this
same-host reference. After those checks, and exact reply/physical date equality,
it maps to a comparison token. Supplied created_at stays exactly the supplied
value; nested created_at and nested server-looking fields stay exact. Untouched
preseed rows stay exactly unchanged, including timestamp absence. IDs, full
profile fields, callback shape and typed physical records remain compared.
Existing server-owned top srvCreated/srvModified compare only after value/type/
reply-storage/carry checks; there is no recursive metadata stripping.

Meaningful negative observations and archived oracle ablations cover missing,
invalid/out-of-window generated dates, reply/storage mismatch, both backends
agreeing on a wrong client date, nested differences, wrong ID, incorrect server
creation carry and original producer mutation. These are source oracle checks;
no DB/native restoration result is implied. The same helper is consumed only by
the PROFILE path in later all-six data-parity preparation; other domains remain
unmeasured and receive no new blanket created_at normalization.

Consumer handoff runtime sockets use a separate uniquely owned0700 temporary
runtime directory, with dev/ino/UID/path/phase recorded into the long capture.
Cleanup requires the same directory inode and empty contents, never recursive
unknown-entry deletion. Capture location and unchanged browser URLs are untouched.
Consumer observation accumulation preserves accepted/suppressed physical rows
through the final cleanup record instead of overwriting them.
