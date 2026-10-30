# ST-VIEWS replay lab: results, 2026-10-29

Does the alarm view of PR #8875 (`lib/data/views`, `compute('alarms')`) raise what today's resident `ddata` path raises, minute by minute over days of uploads? This file holds counts, minutes and plugin names only. Nothing in it comes from a corpus set's values.

## What was run

- Code: branch `lab/views-replay`, which is PR #8875's head `a0470a72` with `official/dev` `991b0654` merged in (merge commit `6f24e183`; the one conflict, `tests/tiers.json`, was resolved as the union of both lists). `lib/data/views` was not changed.
- Environment: Node v22.23.4. MongoDB 7.0.43 in a dedicated container (`mongo:7.0.43`, `--ulimit nofile=64000`), with one database per replay process.
- Existing harness after the merge: `tests/views-equality.test.js` with `VIEWS_CORPUS_DIR` gave 174 passing, 0 failing on 17 synthetic fixtures and 7 corpus sets. The PR's 198 includes the 24 tests that `VIEWS_MEASURE=1` adds.
- Replay (`replay.js`). Each process boots the server (`lib/server/bootevent`), pins the wall clock to the replayed minute (`clock.js`), and uploads each record through `ctx.entries.create`, `ctx.treatments.create`, `ctx.devicestatus.create` and `ctx.profile.create` at its own time, or at `_uploadAt` for a backfill. Every minute it then runs three arms on the same database:
  - **server**: the booted server's own path, `ctx.dataloader.update` on its `ctx.ddata` and cache, then its own `'data-loaded'` handler.
  - **r2**: a second resident path built the way bootevent builds one (the noise-floor control).
  - **view**: `views.compute('alarms')`. Its requested notifies and snoozes are handed to a durable notification service of the view arm's own (`initRequests`, each request in order, `process`), which is the server's step as `lib/data/views` describes it.

  Acknowledgements go to all three notification services at the same minute. Each minute compares the emitted notifications (level, group, plugin, eventName, title, message, clear) and the requested notifies and snoozes (with snooze length).
- Alarm settings: those of `tests/views-equality.test.js` (29 plugins, every alert enabled, `ALARM_TYPES=simple predict`).
- Datasets:
  - **Synthetic**: `timelines.js`, committed.
    - `aaps`, `loop` and `twoUploaders`: 48 h each, after 50 h of preloaded history.
    - `edges`: 28 h, default settings.
    - `edgesDays2`: 52 h, with `DEVICESTATUS_DAYS=2`, `PUMP_URGENT_CLOCK=45` and `PUMP_WARN_CLOCK=20`.
    - `quiet`: 20 h.
  - **Corpus**: the seven sets of `tools/ns2parquet/fixtures`, read in place and replayed over their whole history plus a 26 h tail with no uploads. Spans run from 37.9 h to 630.4 h.
    - Five sets (#3 to #7) carry profile documents dated after their last record, so by their own times no profile was ever uploaded. They were replayed both that way and with `--profiles-at-start`, which uploads those profiles before the first minute.

## Result per dataset (main run)

"Real" means the view differed from the server and the r2 control did not.

| dataset | span (h) | minutes compared | view differs | expected (sage) | artefact (r2 also differs) | real | r2 differs from server |
|---|---|---|---|---|---|---|---|
| corpus #1 | 75.0 | 4498 | 1335 | 0 | 0 | 1335 | 0 |
| corpus #2 | 73.9 | 4436 | 1206 | 0 | 0 | 1206 | 0 |
| corpus #3 | 49.9 | 2997 | 19 | 0 | 0 | 19 | 0 |
| corpus #4 | 50.0 | 2998 | 0 | 0 | 0 | 0 | 0 |
| corpus #5 | 49.9 | 2997 | 0 | 0 | 0 | 0 | 0 |
| corpus #6 | 630.4 | 37827 | 1471 | 0 | 0 | 1471 | 0 |
| corpus #7 | 37.9 | 2274 | 0 | 0 | 0 | 0 | 0 |
| corpus #3, profiles at start | 49.9 | 2997 | 0 | 0 | 0 | 0 | 0 |
| corpus #4, profiles at start | 50.0 | 2998 | 0 | 0 | 0 | 0 | 0 |
| corpus #5, profiles at start | 49.9 | 2997 | 0 | 0 | 0 | 0 | 0 |
| corpus #6, profiles at start | 630.4 | 37827 | 1977 | 0 | 0 | 1977 | 0 |
| corpus #7, profiles at start | 37.9 | 2274 | 0 | 0 | 0 | 0 | 0 |
| synthetic aaps | 48.0 | 2881 | 0 | 0 | 0 | 0 | 0 |
| synthetic loop | 48.0 | 2881 | 0 | 0 | 0 | 0 | 0 |
| synthetic twoUploaders | 48.0 | 2881 | 0 | 0 | 0 | 0 | 0 |
| synthetic edges | 28.0 | 1681 | 0 | 0 | 0 | 0 | 0 |
| synthetic edgesDays2 | 52.0 | 3121 | 0 | 0 | 0 | 0 | 0 |
| synthetic quiet | 20.0 | 1201 | 749 | 0 | 0 | 749 | 0 |

**Noise floor.** The r2 control differed from the server on 0 of the 120,766 minutes it ran (every main row above).

**Decided `sage` difference.** It did not appear: 0 minutes. Dev now carries the BF-207 fix in `sensorage.js`, which keeps the newer event on an equal whole-hour age. On the timelines here (a burst of three Sensor Starts within 9 s in `aaps`, and in `loop` a burst of four within 9 s that straddles a whole hour while sage crosses WARN and URGENT), the resident path and the view gave the same `sage` output.

## The real differences

**In no replayed minute did either path raise an alarm the other did not, or raise one at a different level, plugin, group or title.** Every difference is in the message text of an alarm both paths raised, and is one of two kinds.

### 1. IOB and COB lines missing from the view's message

The resident message carries an `IOB:` line, and on some sets a `COB:` line. The view's message does not. In every one of these minutes the line the view lacks shows zero.

- Where it occurred:
  - corpus #1: 1335 minutes, stale-data URGENT (timeago), from 52.72 h to the end of the tail.
  - corpus #2: 1206 minutes, stale-data URGENT, from 53.83 h to the end.
  - corpus #3 without profile: 19 minutes, 21.20 h to 21.52 h. The alarm was an URGENT ar2 and simplealarms alarm; the IOB line only.
  - corpus #6: 1471 minutes, mostly stale-data alarms between 234.8 h and 288 h; the IOB line only.
  - synthetic `quiet`: 749 minutes from 4.43 h. The alarms were URGENT bwp, ar2 high and low, simplealarms high and low, and stale-data WARN and URGENT.
- Mechanism, from per-minute probes (`VIEWS_REPLAY_PROBE`, counts only):
  - The difference starts on the minute when both of these hold:
    - no device status was uploaded in the last 30 minutes;
    - the last treatment is older than the DIA.
  - At that minute the view's treatment read (the DIA, plus the newest of each device-change event and the newest profile switch) returns nothing. The iob plugin's `calcTotal` then returns `{}` and no display line.
  - The resident path still holds up to 60 h of treatments in its cache. It computes a zero IOB "from treatments" (source Care Portal) and shows `IOB: 0…U`; COB is likewise zero.
  - On corpus #2 the difference starts on exactly the minute the view's treatment count goes from 1 to 0.
- It needs no stored device-change event within 62 days and no profile switch within a year. Otherwise the view's newest-of-type lookups put one in its treatments and the plugin reports a zero as the resident path does. Synthetic `quiet` has none and reproduces it: from 4.43 h, which is the last treatment at 0.4 h plus the 4 h DIA. The same timeline with the four change events added gave 0 differing minutes.

### 2. A lower COB in the view's message (corpus #6 with profiles at start)

On 506 minutes, inside stale-data URGENT alarms in five runs between 240.5 h and 276.2 h, both messages carry a `COB:` line but the view's value is lower than the resident's. In 6 of those minutes the view's COB is zero and the resident's is positive. The other 1471 differing minutes of that run are kind 1.

- Mechanism (probe):
  - Both paths read the same carb entry within the 3 h DIA.
  - The resident path also holds older carb entries, more than three DIAs back, in its 60 h cache.
  - `cob.fromTreatments` chains carb absorption: an earlier entry's decay pushes back when a later one starts to decay.
  - The view reads one DIA of treatments and so starts that decay earlier.
- This is the COB decay chain that `docs/60-research/platform/st-views-census-2026-10-27.md` measured for the properties view, which is why that view reads 3 DIAs. The alarm view's treatment bound is 1 DIA, and on this timeline it changes the COB shown in the alarm message.
- It appeared only with the profile present; without it, the same minutes show kind 1 only.

## Break-it controls

Each control changes the view arm only, through the equality harness's wrapper (`productContext`). "Added" means differing minutes beyond the same dataset's main-run differences. Hours are from the replay start.

| control | red on (added minutes, plugin, hours) | silent on |
|---|---|---|
| `VIEWS_DROP_QUERY=loopOk` | loop 277: loop, 6.9–7.5 h and 21.9–25.9 h (dosing fails 5–7.5 h and 20–27 h, urgent after 60 min)<br>edges 331 and edgesDays2 331: loop, 1.4–7.0 h (failing from 1 h, until the last OK status leaves the 6 h window) | aaps, twoUploaders, quiet (no Loop); corpus #1–#7 |
| `VIEWS_DROP_QUERY=openapsEnacted` | aaps 125: openaps, 36.4–38.5 h (loop stopped 36–38.5 h after the enacted-only stretch) | the other synthetic timelines (both suggested and enacted present); corpus #1–#7 |
| `VIEWS_DROP_QUERY=openapsSuggested` | aaps 125: openaps, 42.4–44.5 h (stopped 42–44.5 h after the suggested-only stretch) | as above |
| `VIEWS_DROP_QUERY=upbatWindow` | aaps 45: upbat, 30.1–31.6 h (two phones)<br>twoUploaders 94: upbat, 7.0–7.6 h and 31.1–32.2 h (low phone among the every-minute phones)<br>edges 101 and edgesDays2 101: upbat, 0–2.8 h | loop, quiet; corpus #1–#7 |
| `VIEWS_DROP_QUERY=pumpWindow` | aaps 85: pump, 44.5–45.9 h (pump uploader stopped at 44 h, stale state re-posted every 10 s)<br>loop 370: pump, 20.9–27.0 h (pump clock frozen) | edges, edgesDays2, twoUploaders, quiet; corpus #1–#7 |
| `VIEWS_TAMPER=alarms` (newest treatment dropped) | every dataset: aaps 839, loop 84, twoUploaders 948, edges 607, edgesDays2 1110, quiet 17, corpus #1 2365, #2 1628, #3 68, #4 1371, #5 565, #6 2018, #7 392. Led by treatmentnotify; then ar2, simplealarms, bwp and timeago | none |
| `VIEWS_DROP_KIND=loop`, `openaps`, `pump`, `uploader`, `uploaderBattery`, `xdripjs` | **none** | every dataset |

**The six newest-of-kind queries are not seen by this replay.** Dropping any one of them changed no minute on any synthetic timeline or corpus set. On these timelines each kind is also brought in by the 10 newest, the 30-minute window, the pump window or the loop and openaps tests. Where only the kind query brings a status, the plugin that reads it either ignores a status that old or gives the same result without it. So this lab does not show that those six queries are needed for any alarm, nor that they are not. That needs a timeline built for each one (for example, an xdripjs status in a non-OK state that is the newest of its kind, more than 30 minutes old, outside the 10 newest and within the 24 h window).

The five named queries are red on synthetic timelines at the scripted minutes, for the scripted plugin. They are silent on all seven corpus sets: none of those sets has a stretch where the newest Loop or OpenAPS status fails its test, several phones report battery, or a stale pump state is re-posted.

## Cost per minute (client-side, main runs)

These were measured with 12 replays running at once on 16 cores, so absolute times are inflated; compare the arms within a row.

- reads: storage-interface calls, including `profile.last`, `food.list` and `db.stats`.
- docs: documents returned.
- KB: the BSON size of the documents returned.
- ms: wall time of the arm's whole minute, less the time spent counting bytes. For the server and r2 arms that is the load plus the plugin pass. For the view arm it is materialise, evaluate and the hand-off.

| dataset | server ms p50 / p95 | view ms p50 / p95 | server reads | view reads | server docs mean (max) | view docs mean (max) | server KB mean (max) | view KB mean (max) |
|---|---|---|---|---|---|---|---|---|
| corpus #1 | 48.6 / 72.1 | 16.9 / 29.4 | 14 | 24 | 9 (41) | 71 (130) | 10.4 (50.1) | 66.2 (119.7) |
| corpus #2 | 23.8 / 40.0 | 15.8 / 24.9 | 14 | 24 | 7 (50) | 59 (106) | 5.0 (38.6) | 31.8 (53.5) |
| corpus #3 | 24.1 / 39.6 | 17.9 / 31.9 | 14 | 24 | 5 (49) | 48 (88) | 4.5 (45.3) | 55.6 (102.3) |
| corpus #4 | 40.2 / 73.0 | 22.6 / 41.9 | 14 | 24 | 6 (45) | 63 (123) | 10.7 (92.9) | 149.4 (316.7) |
| corpus #5 | 28.7 / 45.5 | 18.8 / 31.8 | 14 | 24 | 7 (38) | 53 (91) | 4.8 (39.0) | 55.8 (95.7) |
| corpus #6 | 3.3 / 8.1 | 5.0 / 12.7 | 14 | 24 | 9 (25) | 5 (34) | 1.6 (6.4) | 1.1 (7.5) |
| corpus #7 | 18.0 / 28.1 | 18.0 / 30.6 | 14 | 24 | 6 (42) | 42 (85) | 4.0 (40.8) | 43.9 (91.5) |
| synthetic aaps | 29.7 / 42.6 | 19.5 / 36.9 | 14 | 24 | 19 (106) | 112 (948) | 6.1 (34.1) | 36.5 (304.8) |
| synthetic loop | 59.3 / 99.8 | 14.3 / 25.5 | 14 | 24 | 15 (20) | 102 (115) | 5.6 (6.6) | 49.9 (59.1) |
| synthetic twoUploaders | 46.7 / 65.1 | 21.8 / 35.0 | 14 | 24 | 19 (35) | 108 (141) | 8.3 (11.9) | 64.3 (71.5) |
| synthetic edges | 23.8 / 50.3 | 15.5 / 26.0 | 14 | 24 | 10 (28) | 46 (105) | 2.9 (10.0) | 12.0 (36.8) |
| synthetic edgesDays2 | 27.8 / 60.9 | 13.2 / 24.5 | 14 | 24 | 10 (28) | 43 (99) | 2.6 (10.0) | 11.0 (34.9) |
| synthetic quiet | 7.1 / 15.0 | 6.1 / 10.3 | 14 | 24 | 3 (9) | 29 (67) | 1.2 (4.4) | 15.9 (41.1) |

The resident path reads little each minute, because its loads after the first cover only 15 minutes, but it keeps its whole 48 h, 60 h and 24 h windows in memory and processes them every minute. The view reads its whole bounded window every minute: 24 reads, about 5 to 10 times the documents and bytes of the resident's incremental load. On every dataset except corpus #6 and corpus #7 its minute takes less time; on corpus #7 the medians are equal (18.0 ms each) and the view's p95 is higher. Resident memory was not measured.

## Observed on both paths (not a view difference)

On corpus #3 the pump plugin's URGENT reservoir alarm was refused by `notifications.requestNotify` ("the notify isn't complete") on both paths. The run's 50 logged errors (the cap) were all this. When the pump status supplies `reservoir_level_override` without a reservoir message, `prepareData` (`lib/plugins/pump.js`) takes its level from the override and keeps an undefined `title`, so that alarm is never raised. The refusal is reproduced; the mechanism is read from the code.

## What this lab does not cover

- The six newest-of-kind device-status queries (see the controls above).
- The five named device-status queries on real data: only the synthetic timelines exercise them.
- Upload timing: records arrive at their own time, one batch per minute, except the synthetic backfills. Late uploads beyond a backfill, clock skew, future-dated records, and updates and deletes (`data-update` remove, soft delete, cache invalidation) are not replayed.
- Server scheduling: one evaluation per minute. The debounce on `data-received`, concurrent loads and the websocket ack path are not exercised; acks call each notification service's `ack` directly.
- Settings: one set of alarm settings and mg/dl only. No mmol, no non-default thresholds beyond the `edgesDays2` pump settings, and no Pushover, Maker or webhook (webhook is excluded from the view by design).
- The properties view: not compared here.
- How the view would actually be wired into the multitenant `serve` roles: the view arm's hand-off to durable notifications follows the description in `lib/data/views/index.js`.
- Versions: one MongoDB (7.0.43) and one Node (22.23.4). The r2 arm was not run in the control runs.
- Corpus profile documents: in sets #3 to #7 they are dated after the data, so those sets were run without a profile and again with the profiles uploaded at the start.

## How to run

```
docker run -d --name views-replay-mongo --ulimit nofile=64000:64000 -p 127.0.0.1:27741:27017 mongo:7.0.43
OUT=<dir> PORT=27741 JOBS=12 VIEWS_CORPUS_DIR=<alignment repo>/tools/ns2parquet/fixtures tests/lib/views-replay/run-all.sh main
OUT=<dir> PORT=27741 JOBS=14 VIEWS_CORPUS_DIR=... tests/lib/views-replay/run-controls.sh
node tests/lib/views-replay/summarise.js <dir> main
node tests/lib/views-replay/controls.js <dir>
node tests/lib/views-replay/diffshape.js <dir>/main/<dataset>.jsonl
```

The `.jsonl` files hold the notification text of every differing minute. For a corpus set that text contains its values: keep them out of any repository.
