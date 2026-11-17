'use strict';
// The shape of each differing minute in a replay .jsonl: plugin, level and which
// message lines differ, digits masked; no notification text is printed.
//   node tests/lib/views-replay/diffshape.js <file.jsonl> [server-view|server-r2]

const fs=require("fs");const L=fs.readFileSync(process.argv[2],"utf8").split("\n").filter(Boolean).map(JSON.parse).filter(d=>d.pair===(process.argv[3]||"server-view"));
const lab=l=>(l||"").replace(/-?[0-9][0-9.,:]*/g,"#").slice(0,60);
const out={};
function cmp(kind,A,B,step){
  const key=s=>{const p=s.split("|");return p[0]==="notify"||p[0]==="snooze"?[p[0],p[1],p[3],p[4]].join(":"):["emit",p[0],p[2],p[3],p[6]].join(":")};
  const used=new Set();
  A.forEach(a=>{const j=B.findIndex((b,i)=>!used.has(i)&&key(b)===key(a));
    let k;
    if(j<0){k=kind+" only-server "+key(a)}else{used.add(j);const pa=a.split("|"),pb=B[j].split("|");const f=[];
      for(let i=0;i<pa.length;i++)if(pa[i]!==pb[i]){if(pa[i].includes("\n")||pb[i].includes("\n")){const la=pa[i].split("\n"),lb=pb[i].split("\n");for(let x=0;x<Math.max(la.length,lb.length);x++)if(la[x]!==lb[x])f.push("L"+x+"["+lab(la[x])+"|"+lab(lb[x])+"]")}else f.push("f"+i+"["+lab(pa[i])+"|"+lab(pb[i])+"]")}
      k=kind+" text "+key(a)+" "+f.join(" ")}
    (out[k]=out[k]||[]).push(step)});
  B.forEach((b,i)=>{if(!used.has(i)){const k=kind+" only-other "+key(b);(out[k]=out[k]||[]).push(step)}});
}
L.forEach(d=>{cmp("emit",d.emitted.onlyServer,d.emitted.onlyOther,d.step);cmp("req",d.requested.onlyServer,d.requested.onlyOther,d.step)});
const runs=s=>{const r=[];s.forEach(x=>{const l=r[r.length-1];if(l&&x<=l[1]+1)l[1]=x;else r.push([x,x])});return r.map(a=>a[0]+"-"+a[1])};
Object.keys(out).forEach(k=>{const r=runs(out[k]);console.log(out[k].length,k,"| runs:",r.length>6?r.slice(0,6).join(",")+"... ("+r.length+")":r.join(","))});
