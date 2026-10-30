'use strict';
// The break-it controls of an OUT directory (run-controls.sh), less each
// dataset's main-run differences (OUT/main): what each control adds, by
// plugin and by hours from the replay start. No notification text.
//   node tests/lib/views-replay/controls.js <OUT dir> [dataset filter]
process.chdir(process.argv[2]);
const fs=require("fs"),path=require("path");
const pl=s=>{const p=s.split("|");return p[0]==="notify"||p[0]==="snooze"?p[3]:(p[6]==="clear"?"clear":p[2])};
const runs=s=>{const r=[];s.forEach(x=>{const l=r[r.length-1];if(l&&x<=l[1]+1)l[1]=x;else r.push([x,x])});return r};
const filt=process.argv[3]||"";
fs.readdirSync(".").filter(d=>/^(drop|tamper)/.test(d)&&fs.statSync(d).isDirectory()).sort().forEach(m=>{
 fs.readdirSync(m).filter(f=>f.endsWith(".jsonl")&&f.includes(filt)).sort((a,b)=>a.localeCompare(b,"en",{numeric:true})).forEach(f=>{
  const j=path.join(m,f.replace(".jsonl",".json"));if(!fs.existsSync(j))return;const r=JSON.parse(fs.readFileSync(j));
  const key=d=>JSON.stringify([d.emitted.onlyServer.slice().sort(),d.emitted.onlyOther.slice().sort(),d.requested.onlyServer.slice().sort(),d.requested.onlyOther.slice().sort()]);
  const B=new Map((fs.existsSync(path.join("main",f))?fs.readFileSync(path.join("main",f),"utf8").split("\n").filter(Boolean).map(JSON.parse):[]).filter(d=>d.pair==="server-view").map(d=>[d.step,key(d)]));
  const all=fs.readFileSync(path.join(m,f),"utf8").split("\n").filter(Boolean).map(JSON.parse);
  const L=all.filter(d=>B.get(d.step)!==key(d));
  r.view.any=L.length+" new ("+all.length+" incl. baseline "+B.size+")";
  const P={};L.forEach(d=>[...new Set([].concat(d.emitted.onlyServer,d.emitted.onlyOther,d.requested.onlyServer,d.requested.onlyOther).map(pl))].forEach(p=>P[p]=(P[p]||0)+1));
  const rr=runs(L.map(d=>d.step)).map(a=>(a[0]/60).toFixed(1)+"-"+((a[1]+1)/60).toFixed(1));
  console.log(m.padEnd(26),f.replace(".jsonl","").padEnd(24),String(r.view.any).padStart(6),"/",r.steps,"|",Object.entries(P).map(([k,v])=>k+":"+v).join(" "),"|",rr.length>8?rr.slice(0,8).join(" ")+" ..("+rr.length+")":rr.join(" "))})});
