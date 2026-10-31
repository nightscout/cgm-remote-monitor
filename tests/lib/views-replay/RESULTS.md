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

# Round 2, 2026-10-30: the treatment bound, and the newest-of-kind timelines

Branch `feat/views-bounded-text`, on top of `lab/views-replay`. Same environment as above (Node v22.23.4, MongoDB 7.0.43 in a dedicated container with `--ulimit nofile=64000`), with 15 replays at once.

## The change

`lib/data/views/bounds.js` `treatmentsWindow`: each view reads its DIAs of treatments (1 for alarms, `PROPERTIES_DIAS` for properties, as before) **and the newest treatment within the resident treatment window** (`TREATMENT_CACHE_HOURS`, 60 h: `lib/server/cache.js` retention, and `loadTreatments` loads 2.5 days into an empty cache). The iob and cob plugins show their zero lines whenever they are given any treatment and no line when they are given none. With this one record the view's treatments are empty exactly when the resident path's are. That record is older than the DIA window it is added to, so it adds no IOB. The view now makes one more read per minute.

## Result per dataset (final tree; r2 control on every main run)

| dataset | real differing minutes, round 1 | round 2 | r2 differs |
|---|---|---|---|
| corpus #1 | 1335 | 0 | 0 |
| corpus #2 | 1206 | 0 | 0 |
| corpus #3 | 19 | 0 | 0 |
| corpus #4, #5, #7 | 0 | 0 | 0 |
| corpus #6 | 1471 | 0 | 0 |
| corpus #3, #4, #5, #7, profiles at start | 0 | 0 | 0 |
| corpus #6, profiles at start | 1977 | **538** | 0 |
| synthetic aaps, loop, twoUploaders, edges, edgesDays2 | 0 | 0 | 0 |
| synthetic quiet | 749 | 0 | 0 |
| synthetic kindXdripjs, kindLoop, kindOpenaps, kindPump, kindUploader, kindUploaderBattery (new) | - | 0 | 0 |

Noise floor: r2 differed from the server on 0 of 126,092 minutes (every main and profiles-at-start run).

**What remains (corpus #6 with profiles at start, 538 minutes, five runs between 240.5 h and 276.7 h).** All of these minutes fall inside stale-data URGENT (timeago) alarms. In every one, both paths raise the same alarm (level, plugin, group and title) and the messages differ only in the `COB:` line: the view's COB is lower in 500 minutes, and zero against the resident's positive value in 38. This is round 1's kind 2: COB from treatments chains carb absorption across entries. The view has no current device COB in these minutes, so its COB comes from that chain, which needs the carbs older than the view's window. The zero-line minutes round 1 counted in this run are gone; the count went from 506 to 538 because minutes that used to lack the line entirely now carry a lower value.

## Measured alternatives for the COB chain (alarm view only; r2 not run on AF)

Each variant changes the alarm view's treatment and device-status reads only. Columns: differing minutes, then mean KB read per minute by the view.

| dataset | chosen: 1 DIA + newest in 60 h | 3 DIA + newest in 60 h | 60 h of treatments | 3 DIA + newest in 60 h, + 24 h device status | 60 h of treatments + 24 h device status |
|---|---|---|---|---|---|
| corpus #1 | 0, 66.8 | 0, 121.0 | 0, 297.8 | 0, 641.6 | 0, 818.5 |
| corpus #4 | 0, 149.6 | 0, 158.6 | 0, 201.8 | 0, 896.9 | 0, 940.1 |
| corpus #6, profiles at start | 538, 2.2 | 204, 2.6 | 0, 5.2 | 204, 3.9 | 0, 6.6 |
| synthetic aaps | 0, 36.7 | 0, 39.9 | 13, 60.2 | 0, 293.5 | 0, 313.8 |
| synthetic quiet | 0, 16.2 | 1, 17.8 | 1, 37.6 | 0, 148.7 | 0, 168.5 |
| synthetic twoUploaders | 0, 64.5 | 0, 67.8 | 0, 88.0 | 0, 636.1 | 0, 656.3 |

- Only the last column, the resident path's own windows, was 0 on every dataset. It reads 3 to 12 times the bytes of the chosen bound: 818.5 against 66.8 KB per minute on corpus #1, 680.2 against 11.2 on edgesDays2.
- Reading more treatments alone is not enough. When COB is computed from treatments, the cob plugin evaluates IOB at each earlier carb's decay time (`cob.fromTreatments`, `iob.calcTotal`). That IOB comes from a device status within 30 minutes of that time, when the resident path holds one. The alarm view reads device status only near now, so with a wider treatment window and no matching device status its COB differs the other way (view higher: synthetic quiet, 1 minute; synthetic aaps, 13 minutes).
- In this run each difference was in the COB text only. No variant changed an alarm.

## The six newest-of-kind queries

In each `kind*` timeline, a bridge posts a status with none of the six kinds every minute, and the kind's device stops at 3 h. `viewKindMinutes` counts the minutes on which the view's working set held a status of that kind. Under `dropkind:<kind>` it drops to the minutes the other queries cover, so on the remaining minutes the kind query was the only source.

| timeline | minutes with the kind: main / dropkind | drop adds | why |
|---|---|---|---|
| kindXdripjs | 721 / 206 | **515 minutes, xdripjs WARN (3.4–12.0 h)** | xdripjs reads 24 h; nothing else brings the Logger's status once it is out of the 30-minute window |
| kindLoop | 721 / 476 | 0 | the loop alarm counts from the newest OK status (`loopOk`) and its message names only that time |
| kindOpenaps | 721 / 476 | 0 | the openaps alarm counts from suggested and enacted (the openaps tests) |
| kindPump | 721 / 296 | 0 | the pump plugin ignores statuses outside twice urgentClock (`pumpWindow`) |
| kindUploader | 721 / 206 | 0 | upbat ignores statuses older than 30 minutes (`upbatWindow`) |
| kindUploaderBattery | 721 / 206 (as `uploader`, after the loader's rewrite) | 0 | as kindUploader |

So the xdripjs query is needed. For the other five, each kind's own plugin does not need its query: it was the only source of that kind on 245 to 515 minutes per timeline, and dropping it changed nothing. They do bring device statuses into the view, which the COB chain above can read at an earlier carb's decay time. They were kept in round 2; round 3 replaces all eleven targeted queries with the resident window.

## Break-it controls (final tree)

Unchanged from round 1 on the round-1 datasets: loopOk, openapsSuggested, openapsEnacted, upbatWindow and pumpWindow are red on the same synthetic minutes for the same plugins, and tamper is red on every dataset. On the new timelines, `drop:loopOk` is red on kindLoop for 331 minutes (loop, 2.4–8.0 h), and tamper is red on all six (259–282 minutes each, led by treatmentnotify). `dropkind:xdripjs` is red on kindXdripjs as above. Every other control is silent on every dataset. In the equality harness, `VIEWS_TAMPER=alarms` fails 4 checks and `VIEWS_TAMPER=properties` fails 20, each on its own view only. Untampered, the harness gives 174 passing.

## Cost per minute, alarm view (mean, final run vs round 1)

| dataset | reads | docs | KB |
|---|---|---|---|
| corpus #1 | 24 → 25 | 71 → 72 | 66.2 → 66.8 |
| corpus #4 | 24 → 25 | 63 → 64 | 149.4 → 149.6 |
| corpus #6 | 24 → 25 | 5 → 6 | 1.1 → 1.3 |
| synthetic aaps | 24 → 25 | 112 → 113 | 36.5 → 36.7 |
| synthetic quiet | 24 → 25 | 29 → 30 | 15.9 → 16.2 |

Wall times are not compared, because this round ran 15 replays at once against round 1's 12.

## Still not covered

- The COB chain on corpus #6 with profiles at start, above. An exact bound needs the resident path's windows.
- Everything listed under "What this lab does not cover" in round 1, except the six newest-of-kind queries.

# Round 3, 2026-10-30: the resident windows (maintainer decision)

The maintainer chose exactness over cost: the alarm view reads the resident path's own treatment and device-status windows. Environment: same as round 2, a fresh container, 15 replays at once.

## The change

`lib/data/views/bounds.js`, `alarms`:
- **treatments**: every treatment created within `TREATMENT_CACHE_HOURS` (60 h). This replaces one DIA plus the newest within 60 h, so the alarm view no longer needs the newest-within-60 h record.
- **devicestatus**: every status created within `devicestatusLookback` (24 h, or 48 h with `DEVICESTATUS_DAYS=2`).
  - This one query replaces the eleven targeted queries: the 10 newest, the six newest-of-kind, loopOk, the two openaps tests, and the upbat and pump windows.
  - Each of those lay inside the resident window except the 10 newest, and the resident path holds nothing older than its window.
  - `DEVICESTATUS_KINDS`, `DEVICESTATUS_TESTS` and `pumpWindowMs` are removed.
- **properties** keeps its own treatments: `PROPERTIES_DIAS` (3) DIAs plus the newest within 60 h. Its device status was already the resident window and is unchanged; it now inherits it from `alarms`. Reading 60 h of treatments in the properties view would also need readings around each treatment (the loader's treatment-to-curve fit), and the replay lab does not run the properties view.

## Result

Every dataset in every mode: **0 differing minutes**. That is all seven corpus sets as-is and #3 to #7 with profiles at start, plus the 12 synthetic timelines, including the six `kind*`. corpus #6 with profiles at start, 538 in round 2, is now 0. Noise floor: r2 differed from the server on 0 of 126,092 minutes.

## Break-it controls

The drop controls named queries that no longer exist. They are replaced by `shrink:<kind>:<hours>` (`VIEWS_SHRINK`, `tests/lib/views-equality/views.js`), which keeps only the records created within that many hours of the minute.

| control | red on (added minutes, plugin, hours) | silent on |
|---|---|---|
| `shrink:treatments:4` (about a DIA, the round-1 bound without the newest-in-60 h record) | corpus #1 1482, #2 1542, #6 1146 (timeago, mostly the zero lines); quiet 749 (ar2, simplealarms, bwp, timeago), as round 1 | the rest |
| `shrink:treatments:24` | corpus #1 195, 71.7–75.0 h; corpus #2 126, 71.8–73.9 h (timeago: zero lines lost once the last treatment is over 24 h old) | the rest |
| `shrink:devicestatus:0.5` | loop, openaps and pump alarms on every synthetic timeline that has them and on corpus #1, #3, #4, #5 and #7; xdripjs 515 on kindXdripjs | corpus #2, #6; kindUploader, kindUploaderBattery (upbat reads only 30 minutes) |
| `shrink:devicestatus:6` | kindXdripjs 185, 8.9–12.0 h (xdripjs reads 24 h); aaps 13, 27.2–27.4 h (the COB line: device IOB at an earlier carb's decay time) | the rest |
| `tamper` (newest treatment dropped) | every dataset (16 to 2365 minutes, led by treatmentnotify) | none |

So both windows are needed in full. In the equality harness, untampered and `VIEWS_TAMPER_DRY=1` each give 174 passing; `VIEWS_TAMPER=alarms` fails 4, `VIEWS_TAMPER=properties` fails 20 (each on its own view only); `VIEWS_SHRINK=devicestatus:0.5` fails 14 and `VIEWS_SHRINK=treatments:4` fails 8.

## Cost per minute, alarm view (mean; round 2's bound → this one)

| dataset | reads | docs | KB (max) | resident path's incremental load, KB |
|---|---|---|---|---|
| corpus #1 | 25 → 13 | 72 → 656 | 66.8 → 785.5 (1229) | 10.4 |
| corpus #2 | 25 → 13 | 60 → 437 | 32.0 → 317.6 (482) | 5.0 |
| corpus #3 | 25 → 13 | 49 → 256 | 56.0 → 282.3 (545) | 4.5 |
| corpus #4 | 25 → 13 | 64 → 419 | 149.6 → 798.3 (1615) | 10.7 |
| corpus #5 | 25 → 13 | 54 → 308 | 56.2 → 305.1 (581) | 4.8 |
| corpus #6 | 25 → 13 | 6 → 28 | 1.3 → 5.3 (44) | 1.6 |
| corpus #7 | 25 → 13 | 43 → 171 | 44.3 → 177.3 (266) | 4.0 |
| synthetic aaps | 25 → 13 | 113 → 772 | 36.7 → 283.8 (463) | 6.1 |
| synthetic loop | 25 → 13 | 103 → 964 | 50.1 → 386.0 (402) | 5.6 |
| synthetic twoUploaders | 25 → 13 | 109 → 1041 | 64.5 → 598.6 (677) | 8.3 |
| synthetic edges | 25 → 13 | 47 → 894 | 12.2 → 350.5 (687) | 2.9 |
| synthetic edgesDays2 | 25 → 13 | 44 → 1617 | 11.2 → 675.8 (1338) | 2.6 |
| synthetic quiet | 25 → 13 | 30 → 284 | 16.2 → 157.0 (255) | 1.2 |
| synthetic kind* (six) | 25 → 13 | 69–77 → 1829 | 15–18 → 352–463 | 5.5–5.8 |

Profiles at start add 1 to 3 KB on each corpus set. The view now reads per minute what the resident path keeps in memory: 4 to 60 times the round-2 bytes, and 3 to 260 times the resident path's incremental load. The resident path's memory was not measured.

## Still not covered

As round 1, less the six newest-of-kind queries (gone) and the COB chain (exact here): late uploads beyond the synthetic backfills, updates and deletes, server scheduling and the websocket ack path, other settings and units, notification channels, the properties view under replay, and other Node and MongoDB versions.

# Round 4, 2026-10-30: after official/dev 305a6533, and the properties view

## The alarm view after merging official/dev (305a6533, #8880)

The merge (`4dad5505`) brings BF-213: the pump plugin now raises its reservoir alarm when an uploader sends `reservoir_level_override` without a reservoir value. It also brings the device-status remove reload.

- Alarm replay round 3 again:
  - 0 differing minutes on every dataset and mode;
  - r2 0 of 126,092 minutes;
  - every control red or silent on exactly the minutes it was before the merge.
- On corpus #3 the resident path now emits pump alarms it used to refuse (WARN 185 → 256 minutes, URGENT 314 → 413). The refused-notify errors are gone (50 → 0), and the view matches it on every minute.
- Equality harness: 174 passing. `npm test`: 5051 passing, 3 pending.

## The properties view (`--view properties`)

Each minute, `compute('properties')` is compared with each resident path's `sbx.properties` after its `'data-loaded'` cycle. These are the main page's pills, also served by `GET /api/v2/properties`. Every property is compared on its own and the details carry paths only. Same datasets and modes as the alarm runs, with the r2 control.

Two bounds were measured. Device status is the resident 24 h window in both.
- **current**: the product's `properties` bound. Treatments over 3 DIAs plus the newest within 60 h; readings over 3 DIAs plus the one before.
- **wide** (`--properties-bound wide`, lab only): treatments over the resident 60 h and the loader's own reading query (2 days into an empty cache), so every treatment is matched to the readings the resident path matches it to.

| dataset | minutes | current: differing minutes (property) | wide | r2 (current / wide) | current: reads, docs, KB mean (max) | wide: reads, docs, KB mean (max) |
|---|---|---|---|---|---|---|
| corpus #1 | 4498 | 842 (cob) | 0 | 0 / 0 | 16, 590, 665.3 (1056) | 11, 1187, 945.2 (1504) |
| corpus #2 | 4436 | 566 (cob) | 0 | 0 / 0 | 16, 423, 315.2 (499) | 11, 749, 385.5 (599) |
| corpus #3 | 2997 | 0 | 0 | 0 / 0 | 16, 217, 260.0 (531) | 11, 461, 339.3 (622) |
| corpus #4 | 2998 | 0 | 0 | 0 / 0 | 16, 286, 768.2 (1596) | 11, 622, 849.6 (1683) |
| corpus #5 | 2997 | 0 | 0 | 0 / 0 | 16, 300, 283.1 (579) | 11, 760, 413.1 (724) |
| corpus #6 | 37827 | 0 | 0 | 0 / 0 | 16, 17, 3.7 (63) | 11, 42, 9.1 (99) |
| corpus #7 | 2274 | 0 | 0 | 0 / 0 | 16, 196, 175.2 (321) | 11, 425, 238.7 (341) |
| corpus #3, profiles at start | 2997 | 1551 (cob) | 0 | 0 / 0 | 16, 297, 288.1 (593) | 11, 462, 341.9 (624) |
| corpus #4, profiles at start | 2998 | 500 (cob) | 0 | 0 / 0 | 16, 396, 796.9 (1651) | 11, 623, 852.0 (1686) |
| corpus #5, profiles at start | 2997 | 537 (cob) | 0 | 0 / 0 | 16, 447, 325.4 (673) | 11, 761, 414.4 (726) |
| corpus #6, profiles at start | 37827 | 14472 (cob) | 0 | 0 / 0 | 16, 18, 4.6 (64) | 11, 43, 10.1 (100) |
| corpus #7, profiles at start | 2274 | 0 | 0 | 0 / 0 | 16, 293, 202.9 (345) | 11, 426, 240.1 (342) |
| synthetic aaps | 2881 | 0 | 0 | 0 / 0 | 16, 818, 303.6 (485) | 11, 1327, 440.3 (619) |
| synthetic loop | 2881 | 0 | 0 | 0 / 0 | 16, 570, 310.4 (321) | 11, 1528, 549.4 (566) |
| synthetic twoUploaders | 2881 | 0 | 0 | 0 / 0 | 16, 1162, 640.9 (706) | 11, 1749, 801.7 (846) |
| synthetic edges | 1681 | 582 (cob) | 0 | 0 / 0 | 16, 941, 370.7 (708) | 11, 1459, 509.4 (846) |
| synthetic edgesDays2 | 3121 | 1404 (cob) | 0 | 0 / 0 | 16, 1664, 696.0 (1359) | 11, 2182, 834.8 (1497) |
| synthetic quiet | 1201 | 456 (cob) | 0 | 0 / 0 | 16, 306, 169.8 (276) | 11, 818, 307.5 (414) |
| synthetic kind* (six) | 721 each | 0 | 0 | 0 / 0 | 16, 1876, 372–483 | 11, 2393, 511–622 |

Noise floor: r2 differed from the server on 0 of 252,184 minutes (both bounds).

**What differs under the current bound: only the cob property.** The paths, from a rerun that records every differing path (no values):
- On corpus #1, #2, #3, #4 and #5 and on synthetic edges, edgesDays2 and quiet, only `cob.decayedBy` and `cob.lastCarbs` differ. corpus #1 also differs in `cob.treatmentCOB` on 9 minutes. The COB value and the pill's text (`cob.cob`, `display`, `displayLine`) are equal on every one of these minutes.
  - `decayedBy` is the decay time of the last carb entry in the chain, which the main page shows in the COB pill's details.
  - `lastCarbs` is the newest carb entry; it differs when that entry is older than the view's window.
- On corpus #6 with profiles at start, the shown COB differs too: `cob.cob` on 1632 of the 14,472 minutes and `display`/`displayLine` on 1630. `isDecaying` and `rawCarbImpact` differ on 23.
- iob, basal, bwp, pump, loop, openaps, upbat, sensorState and every other property: 0 minutes on every dataset under both bounds.

**Cost.** The wide bound reads 1.1 to 2.5 times the current bound's bytes per minute (corpus #1 665 → 945 KB; quiet 170 → 308 KB) in 11 reads instead of 16.

## Properties controls (both bounds)

| control | red on |
|---|---|
| `tamper` (the newest device status dropped, `TAMPER.properties`) | every dataset under both bounds (36 to 3235 minutes; upbat, openaps and others) |
| `shrink:treatments:4` | corpus #1, #2, #6 and synthetic aaps, edges, edgesDays2, loop, quiet, twoUploaders (iob, cob and others), both bounds |
| `shrink:treatments:24` | corpus #1 and #2 tails (iob), corpus #6, both bounds; edgesDays2 (cob) under wide |
| `shrink:devicestatus:0.5` | every dataset except corpus #6, kindUploader and kindUploaderBattery (loop, openaps, pump, sensorState, cob), both bounds |
| `shrink:devicestatus:6` | corpus #1, synthetic aaps, edges, edgesDays2, kindXdripjs (sensorState 185 minutes), loop, quiet, twoUploaders, both bounds |

The choice between the two bounds is the maintainer's. The product bound is unchanged.

# Round 5, 2026-10-30: the resident windows for the properties view (maintainer decision)

The maintainer chose round 4's wide bound for the product.

## The change

`lib/data/views/bounds.js` `properties` is now the alarm window with readings by the loader's own query (`entries: 'loader'`, 2 days into an empty cache). Its treatments (60 h) and device status (24 h, or 48 h) come from the alarm window.

Removed, because nothing in the product uses them any more:
- the 3-DIA window (`PROPERTIES_DIAS`);
- the newest-within-60 h record (`treatmentsWindow`);
- the profile's DIA (`diaHours` and `info.diaHours`). `diaHours` moves to the test helper, where the harness and the replay probe use it.

In the equality harness the test-only summary spec is now the properties bound, which contains its readings, treatments and temp targets; `VIEWS_COB_DIAS` is gone. The replay's lab-only `--properties-bound` option is removed, since the product bound is the round-4 wide one.

## Result (fresh container, 15 replays at once)

| view | minutes compared (all datasets, as-is and profiles at start) | view differs | r2 differs |
|---|---|---|---|
| alarms | 126,092 | 0 | 0 |
| properties | 126,092 | 0 | 0 |

Every control was red or silent on exactly the same minutes as before: the alarm controls as round 4, the properties controls as round 4's wide bound. In the equality harness:
- untampered and dry-run tamper: 174 passing;
- tamper alarms fails 4, properties 20, summary 23, current 24, page 23, each on its own view only (checked for alarms, properties and summary);
- `VIEWS_SHRINK=devicestatus:0.5` fails 14 and `treatments:4` fails 8.

`npm test`: 5051 passing, 3 pending.

## Cost per minute, properties view (mean; round 4's current bound → this one)

Reads per minute go from 16 to 11. Selected datasets (mean docs and KB per minute):

| dataset | docs | KB |
|---|---|---|
| corpus #1 | 590 → 1187 | 665.3 → 945.2 |
| corpus #4 | 286 → 622 | 768.2 → 849.6 |
| corpus #6 | 17 → 42 | 3.7 → 9.1 |
| synthetic loop | 570 → 1528 | 310.4 → 549.4 |
| synthetic quiet | 306 → 818 | 169.8 → 307.5 |

The alarm view's cost is round 3's.
