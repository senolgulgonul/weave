// render an .asc as SVG with differing nets (schematic side) highlighted in red
'use strict';
const fs=require('fs');
const { SYMBOLS, rot, parseNetlist, classifyNets, railLabel, blockAsySource } = require('./core.js');
const [nlF, ascF, outF, region] = process.argv.slice(2);
const asc=fs.readFileSync(ascF,'latin1'); const nl=fs.readFileSync(nlF,'latin1');
// --- parse asc
const wires=[], flags=[], syms=[]; let cur=null;
for (const ln of asc.split(/\r?\n/)){ const t=ln.trim().split(/\s+/);
  if(t[0]==='WIRE') wires.push(t.slice(1,5).map(Number));
  else if(t[0]==='FLAG') flags.push({x:+t[1],y:+t[2],name:t[3]});
  else if(t[0]==='SYMBOL'){cur={sym:t[1],x:+t[2],y:+t[3],rot:t[4]};syms.push(cur);}
  else if(t[0]==='SYMATTR'&&cur){ if(t[1]==='InstName')cur.name=t.slice(2).join(' '); if(t[1]==='Value')cur.value=t.slice(2).join(' ');}
}
class UF{constructor(){this.p=new Map();}find(k){if(!this.p.has(k))this.p.set(k,k);let r=k;while(this.p.get(r)!==r)r=this.p.get(r);while(this.p.get(k)!==r){const n=this.p.get(k);this.p.set(k,r);k=n;}return r;}union(a,b){this.p.set(this.find(a),this.find(b));}}
const key=p=>p[0]+','+p[1];
const onSeg=(p,w)=>{const[x1,y1,x2,y2]=w; if(x1===x2)return p[0]===x1&&p[1]>=Math.min(y1,y2)&&p[1]<=Math.max(y1,y2); if(y1===y2)return p[1]===y1&&p[0]>=Math.min(x1,x2)&&p[0]<=Math.max(x1,x2); return false;};
const uf=new UF(); const pts=new Set(); const pinRecs=[];
for(const s of syms){ const mb=s.sym.match(/^__block(\d+)$/); if(mb && !SYMBOLS[s.sym]) require('./core.js').blockAsyFiles && (()=>{})(); if(mb&&!SYMBOLS[s.sym]){ /* re-register */ const n=+mb[1]; const perSide=Math.ceil(n/2); const H=Math.max(96,perSide*48); const pins=[],ord=[]; for(let i=0;i<n;i++){const left=i<perSide;const idx=left?i:(i-perSide);const cnt=left?perSide:(n-perSide);const y=Math.round((H*(idx+0.5)/cnt)/16)*16;pins.push([left?-64:64,y]);ord.push(i+1);} SYMBOLS[s.sym]={pins,ord,bbox:[-64,0,64,Math.round(H/16)*16],synthetic:true}; }
  const S=SYMBOLS[s.sym]; if(!S) throw new Error('unknown '+s.sym);
  S.pins.forEach((p,i)=>{const rp=rot(p,s.rot);const abs=[s.x+rp[0],s.y+rp[1]];pinRecs.push({comp:s.name,idx:i,pt:abs,s});pts.add(key(abs));}); }
for(const f of flags)pts.add(key([f.x,f.y]));
for(const w of wires){pts.add(key([w[0],w[1]]));pts.add(key([w[2],w[3]]));}
for(const w of wires){const on=[...pts].map(k=>k.split(',').map(Number)).filter(p=>onSeg(p,w));on.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);for(let i=1;i<on.length;i++)uf.union(key(on[i-1]),key(on[i]));}
const groupName=new Map(); for(const f of flags){groupName.set(uf.find(key([f.x,f.y])),f.name);}
const nets=new Map(); // nk -> {pins:Set, g}
for(const pr of pinRecs){const g=uf.find(key(pr.pt)); const nk=groupName.has(g)?'FLAG:'+groupName.get(g):'G:'+g; if(!nets.has(nk))nets.set(nk,{pins:new Set(),groups:new Set()}); nets.get(nk).pins.add(pr.comp+':'+pr.idx); nets.get(nk).groups.add(g);}
// netlist side
const {comps}=parseNetlist(nl); const cls=classifyNets(comps); const A=new Map();
for(const c of comps)c.nets.forEach((n,i)=>{const t=cls.get(n);const nk=t==='gnd'?'FLAG:0':t==='rail'?'FLAG:'+railLabel(n,comps):'NET:'+n; if(!A.has(nk))A.set(nk,new Set()); A.get(nk).add(c.name+':'+i);});
const sig=s=>[...s].sort().join('|'); const sigA=new Set([...A.values()].map(sig));
const badGroups=new Set(); let nbad=0;
for(const [nk,v] of nets){ if(!sigA.has(sig(v.pins))){ nbad++; for(const g of v.groups) badGroups.add(g);} }
console.error('schematic-side differing nets:',nbad);
// --- render
const [rx0,ry0,rx1,ry1]= region? region.split(',').map(Number) : (()=>{let xs=[],ys=[];for(const w of wires){xs.push(w[0],w[2]);ys.push(w[1],w[3]);}return [Math.min(...xs)-40,Math.min(...ys)-40,Math.max(...xs)+40,Math.max(...ys)+40];})();
const W=rx1-rx0,H=ry1-ry0; const sc=1.0;
let out=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${rx0} ${ry0} ${W} ${H}" width="${W*sc}" height="${H*sc}" font-family="Helvetica, Arial, sans-serif">\n<rect x="${rx0}" y="${ry0}" width="${W}" height="${H}" fill="white"/>\n`;
// symbols: bounding boxes + pins
for(const s of syms){ const S=SYMBOLS[s.sym]; const bb=S.bbox||S.box||null; let corners=[];
  if(bb && bb.length===4){ const [x0,y0,x1,y1]=bb; corners=[[x0,y0],[x1,y0],[x1,y1],[x0,y1]].map(p=>rot(p,s.rot)).map(p=>[s.x+p[0],s.y+p[1]]); }
  else { const ps=S.pins.map(p=>rot(p,s.rot)); const xs=ps.map(p=>p[0]),ys=ps.map(p=>p[1]); corners=[[Math.min(...xs),Math.min(...ys)],[Math.max(...xs),Math.min(...ys)],[Math.max(...xs),Math.max(...ys)],[Math.min(...xs),Math.max(...ys)]].map(p=>[s.x+p[0],s.y+p[1]]); }
  const xs=corners.map(c=>c[0]),ys=corners.map(c=>c[1]); const x0=Math.min(...xs),y0=Math.min(...ys),x1=Math.max(...xs),y1=Math.max(...ys);
  if(x1<rx0||x0>rx1||y1<ry0||y0>ry1) continue;
  out+=`<rect x="${x0}" y="${y0}" width="${Math.max(x1-x0,8)}" height="${Math.max(y1-y0,8)}" fill="#f6f2d8" stroke="#555" stroke-width="1.2"/>\n`;
  out+=`<text x="${x0+4}" y="${y0-4}" font-size="11" fill="#222">${s.name||''}</text>\n`;
}
// wires
for(const w of wires){ const g=uf.find(key([w[0],w[1]])); const bad=badGroups.has(g);
  if(Math.max(w[0],w[2])<rx0||Math.min(w[0],w[2])>rx1||Math.max(w[1],w[3])<ry0||Math.min(w[1],w[3])>ry1) continue;
  out+=`<line x1="${w[0]}" y1="${w[1]}" x2="${w[2]}" y2="${w[3]}" stroke="${bad?'#d62728':'#1a1a8c'}" stroke-width="${bad?3:1.3}" stroke-linecap="round"/>\n`;}
// pins of differing nets
for(const pr of pinRecs){ const g=uf.find(key(pr.pt)); if(badGroups.has(g)&&pr.pt[0]>=rx0&&pr.pt[0]<=rx1&&pr.pt[1]>=ry0&&pr.pt[1]<=ry1) out+=`<circle cx="${pr.pt[0]}" cy="${pr.pt[1]}" r="3.5" fill="#d62728"/>\n`; }
for(const f of flags){ if(f.x<rx0||f.x>rx1||f.y<ry0||f.y>ry1)continue; out+=`<text x="${f.x+3}" y="${f.y+12}" font-size="10" fill="#006400">${f.name}</text>\n`;}
out+='</svg>\n'; fs.writeFileSync(outF,out); console.error('wrote',outF);
