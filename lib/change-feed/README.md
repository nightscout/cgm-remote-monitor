# Retired change-feed catalogue

The experimental feed reader, pgoutput decoder, listener consumer and polling
configuration have been removed. Product evaluator capture uses maintained
pgstream; realtime consumes committed evaluator output. The retired role and
private `change-feed-v1` diagnostic selector are refused before effects.

[`postgres-candidate.json`](postgres-candidate.json) remains unchanged for
recognition of historical migration ledgers and retained backup evidence. It
does not select a running transport. Existing captures retain their original
source and instrument attribution.
