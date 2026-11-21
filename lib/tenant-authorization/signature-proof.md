# Local signature proofs

The local Ed25519 access-token verifier reuses successful mathematical proofs.
It still resolves the current trusted key descriptor on every call, then checks
all existing claims, issuer/audience/purpose, tenant and expiry rules. Current
DB authority is still fetched for every authentication attempt. No credential,
grant, claim-validation, key-availability or negative result is cached. The
legacy/Vault verification path remains unchanged.

A proof matches the exact signed bytes, signature, current FIPS mode and current
public material. An identical immutable native public KeyObject has identical
material. A different object must match the exact public DER before any reuse;
a same-kid replacement with different material still performs fresh crypto and
refuses the old signature. DER work is deferred until such a potential hit,
avoiding unconditional public-key export on cold misses.

One process-wide LRU has at most 256 positive entries, one MiB of encoded proof
keys and optional DER, and 16 KiB per entry. Its key strings are ASCII, so the
encoded byte accounting is exact; this is not a V8 heap or RSS budget claim.
Retained native Ed25519 key references are also bounded by the entry count.
Oversized inputs and misses use the existing crypto primitive; failed proofs
are never retained. Bounds do not grow with tenants or verifier instances.

The developer instrument `scripts/profile-access-signature-proof.js` accepts an
explicit local verifier module path. It covers repeated credentials, unique
credentials and 1000/3000 distinct tenant/key/credential working sets, with
consecutive or interleaved pairs. It emits counts and aggregate timings only.
This is a one-worker verifier mechanism measurement, not a DB, socket, heap or
whole-deployment capacity claim. Reuse helps consecutive consumers; a rotating
working set larger than the bound can have no hits. The existing policy and
current authority checks still run in both cases.

`scripts/test-signature-proof-control.js` copies exact source into owned scratch
and independently breaks the proof key, entry limit and encoded byte limit.
The corresponding security/resource assertions must each fail before the
control is accepted. No working source or peer worktree is mutated.
