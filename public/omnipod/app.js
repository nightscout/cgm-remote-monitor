// Omnipod Overlay — same-origin Nightscout. No tokens. Uses /api/v1/* from THIS instance.
// Color gates: 90–120 green; 70–180 amber; outside red. Sleep window: 22:00–07:30.

const el = s => document.querySelector(s);
const fmt = n => (n==null || Number.isNaN(+n) ? "—" : Number(n).toFixed(2).replace(/\.00$/,''));
const toLocal = ms => new Date(ms).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

function inWindow(start, end, now = new Date()){
  const [sh,sm] = start.split(':').map(Number), [eh,em] = end.split(':').map(Number);
  const s = new Date(now), e = new Date(now);
  s.setHours(sh,sm,0,0); e.setHours(eh,em,0,0);
  return (sh*60+sm) <= (eh*60+em) ? (now>=s && now<=e) : (now>=s || now<=e);
}

function arrowFrom(direction){
  const map = { DoubleUp:"↑↑", SingleUp:"↑", FortyFiveUp:"↗︎", Flat:"→",
                FortyFiveDown:"↘︎", SingleDown:"↓", DoubleDown:"↓↓" };
  return map[direction] || "→";
}

function colorFor(v){
  const n = Number(v);
  if (Number.isNaN(n)) return "";
  if (n >= 90 && n <= 120) return "val-green";
  if (n >= 70 && n <= 180) return "val-amber";
  return "val-red";
}

function scheduledBasalFromProfile(profile){
  try{
    const store = profile[0]?.store;
    const defName = profile[0]?.defaultProfile;
    const segs = store?.[defName]?.basal || [];
    const now = new Date();
    const minutesNow = now.getHours()*60 + now.getMinutes();
    let current = segs[0]?.value ?? null;
    for (const s of segs){
      const mins = s.timeAsSeconds ? (s.timeAsSeconds/60) :
                   (s.time ? (parseInt(s.time.split(':')[0])*60 + parseInt(s.time.split(':')[1]||"0")) : 0);
      if (mins <= minutesNow) current = s.value;
    }
    return current;
  }catch(e){ return null; }
}

async function run(){
  try{
    const [entries, dev, treats, profile] = await Promise.all([
      fetch('/api/v1/entries/sgv.json?count=2', {cache:'no-store'}).then(r=>r.json()),
      fetch('/api/v1/devicestatus.json?count=1', {cache:'no-store'}).then(r=>r.json()),
      fetch('/api/v1/treatments.json?count=20', {cache:'no-store'}).then(r=>r.json()),
      fetch('/api/v1/profile.json', {cache:'no-store'}).then(r=>r.json())
    ]);

    const e0 = entries?.[0], e1 = entries?.[1];
    const bg = e0?.sgv ?? e0?.glucose ?? null;
    const ts0 = e0?.date ?? Date.parse(e0?.dateString || 0);
    const dir = e0?.direction || null;

    let delta5 = null;
    if (e0 && e1){
      const v0 = e0.sgv ?? e0.glucose, v1 = e1.sgv ?? e1.glucose;
      const dtMin = Math.max(1, (((e0.date ?? Date.parse(e0.dateString)) - (e1.date ?? Date.parse(e1.dateString)))/60000));
      delta5 = ((v0 - v1) / dtMin) * 5;
    }

    const d0 = dev?.[0] || {};
    const iob = d0?.iob?.iob ?? d0?.openaps?.iob?.iob ?? null;
    const cob = d0?.cob?.cob ?? d0?.openaps?.cob?.cob ?? null;

    const basal =
      d0?.pump?.basal?.current ??
      d0?.pump?.extended?.basal ??
      scheduledBasalFromProfile(profile);

    const lastBolus = (treats || []).find(t => ['Bolus','Meal Bolus'].includes(t.eventType));
    const bolusU = lastBolus?.insulin ?? null;
    const bolusAt = lastBolus?.created_at ? toLocal(Date.parse(lastBolus.created_at)) : null;

    el('#bg').textContent = bg ?? '—';
    el('#bg').className = `big ${colorFor(bg)}`;
    el('#arrow').textContent = arrowFrom(dir);
    el('#delta').textContent = (delta5==null ? '—' : `${delta5>0?'+':''}${delta5.toFixed(1)} mg/dL/5m`);
    el('#iob').textContent = fmt(iob);
    el('#cob').textContent = fmt(cob);
    el('#basal').textContent = (basal!=null ? `${fmt(basal)} u/hr` : '—');
    el('#bolus').textContent = (bolusU!=null ? `${fmt(bolusU)} u` : '—');
    el('#bolus_meta').textContent = (bolusAt ? ` @ ${bolusAt}` : '');
    el('#updated').textContent = (ts0 ? `Updated ${toLocal(ts0)}` : '—');

    const sleeping = inWindow('22:00','07:30', new Date());
    el('#sleepBand').classList.toggle('sleep', sleeping);
    el('#sleepBadge').style.display = (sleeping ? 'inline-block' : 'none');
  } catch (err){
    el('#updated').textContent = `Error: ${err.message}`;
  }
}

document.getElementById('refresh').addEventListener('click', run);
run();
setInterval(run, 60*1000);
