// netlist2asc: SPICE netlist -> LTspice .asc via elkjs layered layout
// Pin tables verified against evenator/LTSpice-Libraries sym/*.asy (fetched 2026-07-02)
'use strict';
const ELK = require('elkjs');
const GRID = 16;

// ---------- symbol library (generated from real .asy files) ----------
// entries: pins (SpiceOrder-sorted LTspice offsets), grid-rounded bbox, body geometry
const SYMBOLS = require('./symbols.json');
// X subckt name -> symbol key (case-insensitive on the .asy base name)
const SUBCKT2SYM = {};
for (const k of Object.keys(SYMBOLS)) SUBCKT2SYM[k.split('\\').pop().toLowerCase()] = k;
// synthetic rectangular block for a known part whose .asy pin count differs
// from the netlist call (LTspice .subckt exposes ports the glyph hides).
// pins split down the two vertical sides by SpiceOrder; connectivity exact.
function genericBlock(npins){
  const key='__block'+npins;
  if (SYMBOLS[key]) return key;
  const perSide=Math.ceil(npins/2);
  const H=Math.max(96, perSide*48);
  const pins=[], ord=[];
  for (let i=0;i<npins;i++){
    const left=i<perSide;
    const idx=left?i:(i-perSide);
    const cnt=left?perSide:(npins-perSide);
    const y=Math.round((H*(idx+0.5)/cnt)/16)*16;
    pins.push([left?-64:64, y]); ord.push(i+1);
  }
  SYMBOLS[key]={pins, ord, bbox:[-64,0,64,Math.round(H/16)*16], synthetic:true};
  return key;
}

function resolveSub(sub, npins){
  const q = sub.toLowerCase();
  const ok = k => k && SYMBOLS[k].pins.length===npins ? k : null;
  let k = ok(SUBCKT2SYM[q]); if (k) return k;
  if (q.includes('/')) { k = ok(SUBCKT2SYM[q.split('/')[0]]); if (k) return k; }
  // strip package suffixes: LTC1100CS -> LTC1100, LT1006S8 -> LT1006
  const m = q.match(/^([a-z]+\d+[a-z]?(?:-[\d.]+)?)/);
  if (m){ k = ok(SUBCKT2SYM[m[1]]); if (k) return k; }
  // last resort: any table entry whose base name is a prefix of the query
  for (const b of Object.keys(SUBCKT2SYM)){
    if (b.length>=5 && q.startsWith(b)){ k = ok(SUBCKT2SYM[b]); if (k) return k; }
  }
  // grade/package letter variants: PC817 -> PC817A/B/C/D, pick any at npins
  for (const suf of ['a','b','c','d','-1','-2','-3','-5']){
    k = ok(SUBCKT2SYM[q+suf]); if (k) return k;
  }
  // known part, wrong pin count: is the bare/base name present at ANY count?
  const base = q.match(/^([a-z]+\d+[a-z]?(?:-[\d.]+)?)/);
  let known = SUBCKT2SYM[q] || (base && SUBCKT2SYM[base[1]]);
  if (!known) for (const suf of ['a','b','c','d']){ if (SUBCKT2SYM[q+suf]){ known=SUBCKT2SYM[q+suf]; break; } }
  if (known) return genericBlock(npins);   // synthetic block, connectivity exact
  return null;
}
const PREFIX2SYM = { R:'res', C:'cap', L:'ind', V:'voltage', I:'current', D:'diode' };

// LTspice rotation: M applies x -> -x first, then Rk rotates by k deg
function rot([x,y], code){
  if (code[0]==='M') x = -x;
  const k = parseInt(code.slice(1),10);
  if (k===0)   return [x,y];
  if (k===90)  return [-y,x];
  if (k===180) return [-x,-y];
  if (k===270) return [y,-x];
  throw new Error('bad rot '+code);
}
function rotBBox(b, code){
  const p1 = rot([b[0],b[1]],code), p2 = rot([b[2],b[3]],code);
  return [Math.min(p1[0],p2[0]),Math.min(p1[1],p2[1]),Math.max(p1[0],p2[0]),Math.max(p1[1],p2[1])];
}
const snap = v => Math.round(v/GRID)*GRID;

// ---------- netlist parser ----------
function parseNetlist(text){
  // join SPICE '+' continuation lines before parsing
  text = text.split(/\r?\n/).reduce((a,ln)=>{
    if (/^\s*\+/.test(ln) && a.length) a[a.length-1]+=' '+ln.replace(/^\s*\+\s*/,'');
    else a.push(ln);
    return a;
  },[]).join('\n');
  const comps = [], directives = [];
  const lines = text.split(/\r?\n/);
  // join continuation lines (+)
  const joined = [];
  for (let ln of lines){
    if (/^\s*\+/.test(ln) && joined.length) joined[joined.length-1] += ' '+ln.replace(/^\s*\+/,' ');
    else joined.push(ln);
  }
  for (let i=0;i<joined.length;i++){
    let ln = joined[i].trim();
    if (!ln || ln.startsWith('*') || ln.startsWith(';')) continue;
    if (i===0 && !/^[.RCLVIX]/i.test(ln[0])) continue; // title line safety
    if (ln.startsWith('.')){
      if (!/^\.end\b/i.test(ln)) directives.push(ln);
      continue;
    }
    const tok = ln.split(/\s+/);
    const name = tok[0], P = name[0].toUpperCase();
    if ('RCLVID'.includes(P)){
      const value = tok.slice(3).join(' ');
      comps.push({ name, sym: PREFIX2SYM[P], nets: [tok[1],tok[2]], value });
    } else if (P==='E' || P==='G'){
      // VCVS/VCCS: 4 nodes then gain/expression
      const nets=tok.slice(1,5);
      comps.push({ name, sym: P==='E'?'e':'g', nets, value: tok.slice(5).join(' ') });
    } else if (P==='F' || P==='H'){
      // CCCS/CCVS: 2 nodes then controlling source and gain
      const nets=tok.slice(1,3);
      comps.push({ name, sym: P==='F'?'f':'h', nets, value: tok.slice(3).join(' ') });
    } else if (P==='B'){
      // behavioral source: 2 nodes then V=/I= expression
      const nets=tok.slice(1,3);
      const expr=tok.slice(3).join(' ');
      comps.push({ name, sym: /^I\s*=/i.test(expr)?'bi':'bv', nets, value: expr });
    } else if (P==='S'){
      // voltage switch: out+ out- ctl+ ctl- model
      const nets=tok.slice(1,5);
      comps.push({ name, sym:'sw', nets, value: tok.slice(5).join(' ') });
    } else if (P==='W'){
      // current switch: 2 nodes, Vsense model
      const nets=tok.slice(1,3);
      comps.push({ name, sym:'csw', nets, value: tok.slice(3).join(' ') });
    } else if (P==='A'){
      // LTspice special-function device: 8 terminals, model, PARAM=VAL tail.
      // symbol pins map onto the 8 A-terminals via their SpiceOrder numbers
      const body=tok.slice(1);
      let mi=-1;
      for (let z=8; z<body.length; z++) if (!body[z].includes('=')){ mi=z; break; }
      if (mi<0 || body.length<9) throw new Error(name+': A-device model token missing');
      const nodes8=body.slice(0,8), model=body[mi];
      const alias={samplehold:'SpecialFunctions\\sample'};
      const q=model.toLowerCase();
      let sym = alias[q]
        || (SYMBOLS['Digital\\'+q] ? 'Digital\\'+q : null)
        || (SYMBOLS['SpecialFunctions\\'+q] ? 'SpecialFunctions\\'+q : null);
      if (!sym || !SYMBOLS[sym] || !SYMBOLS[sym].ord)
        throw new Error(name+': A-device symbol '+model+' not in table');
      const nets=SYMBOLS[sym].ord.map(o=>nodes8[o-1]);
      comps.push({ name, sym, nets, value: model+' '+body.slice(mi+1).join(' ') });
    } else if (P==='J'){
      // real JFETs have 3 nodes; a 2-node "J" is a renamed jumper/short
      const nets3=tok.slice(1,tok.length-1);
      if (tok.length-1-1===2 || (tok.length===3)){
        comps.push({ name, sym:'Misc\\jumper', nets:tok.slice(1,3), value:'' });
      } else {
        const model=tok[tok.length-1];
        const nets=tok.slice(1,tok.length-1);
        if (nets.length!==3) throw new Error(name+': JFET expects 3 nodes');
        const sym=/^p|pjf|2n54|lsj/i.test(model)?'pjf':'njf';
        comps.push({ name, sym, nets, value: model });
      }
    } else if (P==='T'){
      // lossless transmission line: 4 nodes then params
      const nets=tok.slice(1,5);
      comps.push({ name, sym:'ltline', nets, value: tok.slice(5).join(' ') });
    } else if (P==='K'){
      directives.push(ln);   // coupling statement is schematic text
      continue;
    } else if (P==='Q' || P==='M'){
      let te = tok.length-1;
      while (te>1 && tok[te].includes('=')) te--;   // drop Tambient=.. tails
      const model = tok[te];
      const nodes = tok.slice(1, te);
      if (nodes.length!==3 && nodes.length!==4)
        throw new Error(name+': expected 3 or 4 nodes, got '+nodes.length);
      // netlists do not carry polarity; guess from the model name, default N-type
      const PNP=/pnp|2n3906|2n2907|2n5401|2n4403|bc327|bc32[78]|bc55[678]|bc85[678]|bc860|mmbt390?6|mmbt2907|tip3[02]|tip42|bd13[68]|bd140|s8550|ss8550/i;
      const PMOS=/pmos|irf9\d|irf954|si23\d|bss84|ao340[13]|irlml640[12]|fdn34[08]p|ndp6020p|zvp/i;
      let base = (P==='Q') ? (PNP.test(model)?'pnp':'npn') : (PMOS.test(model)?'pmos':'nmos');
      // LTspice exports 3-pin BJTs/MOSFETs with the bulk/substrate appended as
      // a 4th node tied to ground (Q) or source (M); collapse those back to
      // the standard 3-pin symbol instead of the 4-terminal variant
      let use = nodes;
      if (nodes.length===4 && ((P==='Q' && nodes[3]==='0') || (P==='M' && nodes[3]===nodes[2])))
        use = nodes.slice(0,3);
      const sym = base + (use.length===4?'4':'');
      if (!SYMBOLS[sym]) throw new Error(name+': no symbol '+sym);
      comps.push({ name, sym, nets: use, value: model });
    } else if (P==='X'){
      // subckt name = last non-param token; PARAM=VAL tails are kept in value
      let se = tok.length-1;
      while (se>1 && tok[se].includes('=')) se--;
      const sub = tok[se];
      const params = tok.slice(se+1).join(' ');
      const nets = tok.slice(1, se);
      let sym = resolveSub(sub, nets.length);
      if (!sym && nets.length===5) sym = 'Opamps\\opamp2';   // generic opamp
      if (!sym && nets.length===2) sym = 'res';              // 2-pin: generic two-terminal
      else if (!sym && nets.length>=3) sym = genericBlock(nets.length); // last resort block
      if (!sym) throw new Error(name+': unknown subckt "'+sub+'" with '+nets.length+
        ' pins. Known symbols: '+Object.keys(SUBCKT2SYM).sort().join(', ')+
        '. 5-pin subckts fall back to opamp2.');
      if (SYMBOLS[sym].pins.length !== nets.length)
        throw new Error(name+': "'+sub+'" symbol has '+SYMBOLS[sym].pins.length+' pins, netlist gives '+nets.length);
      comps.push({ name, sym, nets, value: sub + (params?' '+params:'') });
    } else {
      // tolerant fallback: lines like "U1 in- inm vp vm out LT1002A"
      // (extractor netlists carry no X prefix); accept as X-card when the
      // last token resolves to a known symbol or a 5-pin opamp
      let se2 = tok.length-1;
      while (se2>1 && tok[se2].includes('=')) se2--;
      const sub = tok[se2];
      const params2 = tok.slice(se2+1).join(' ');
      const nets = tok.slice(1, se2);
      let sym = resolveSub(sub, nets.length);
      if (!sym && nets.length===5) sym = 'Opamps\\opamp2';
      if (sym && SYMBOLS[sym].pins.length===nets.length){
        comps.push({ name, sym, nets, value: sub + (params2?' '+params2:'') });
      } else if (tok.length>=3){
        // instance names don't always encode the element type: LTspice lets
        // any part be renamed (a resistor called ZA3, etc). For a two- or
        // three-terminal line whose value looks passive or is a crystal /
        // jumper, fall back to a sensible symbol by shape.
        const twoNets = tok.slice(1,3);
        const val = tok.slice(3).join(' ');
        const passiveVal = /^[{(]|^[\d.]+(meg|k|m|u|µ|n|p|f|g|t|r)?\d*$|^[\d.]+e[-+]?\d+/i.test(val);
        if (/xtal|crystal|quartz/i.test(val) || /^Y/i.test(name))
          comps.push({ name, sym:'Misc\\xtal', nets:twoNets, value:val });
        else if (/jumper|short/i.test(val) || (twoNets.length===2 && !val))
          comps.push({ name, sym:'Misc\\jumper', nets:twoNets, value:val });
        else if (passiveVal && twoNets.length===2){
          // pick R/C/L from the unit; default to resistor
          let sy='res';
          if (/[{(]/.test(val) || /f$/i.test(val.replace(/[{}()]/g,''))) sy='cap';
          comps.push({ name, sym:sy, nets:twoNets, value:val });
        } else throw new Error('unsupported element: '+name);
      } else {
        // unknown instance prefix (Z, Y, ...): these are LTspice naming
        // variants of ordinary parts. Infer from node count: 2 nodes -> a
        // generic two-terminal (res body), so the net topology is preserved
        // even if the exact glyph is unknown.
        // nodes = leading tokens until the first value-looking token
        const body = tok.slice(1).filter(t2=>!t2.includes('='));
        let nEnd = body.length;
        for (let z=0; z<body.length; z++){
          if (/^[\d.{+-]/.test(body[z])){ nEnd=z; break; }
        }
        if (nEnd===2){
          comps.push({ name, sym:'res', nets: body.slice(0,2), value: body.slice(2).join(' ') });
        } else {
          throw new Error('unsupported element: '+name);
        }
      }
    }
  }
  return { comps, directives };
}

// ---------- net classification ----------
function classifyNets(comps){
  const cls = new Map(); // net -> 'gnd' | 'rail' | 'signal'
  const allNets = new Set();
  comps.forEach(c => c.nets.forEach(n => allNets.add(n)));
  for (const n of allNets) cls.set(n, (n==='0') ? 'gnd' : 'signal');
  // rail = net tied to a DC V-source whose other terminal is gnd, and name looks like a rail
  for (const c of comps){
    if (c.sym==='voltage' && /^[-+]?\d/.test(c.value) && !/SINE|PULSE|PWL|AC|EXP|SFFM/i.test(c.value)){
      // only user-labelled nets become rail flags; auto-named nets (N001...)
      // mean the original schematic had a wire there, so keep the source wired
      const [a,b] = c.nets;
      const named = n => !/^n\d+$/i.test(n);
      if (a==='0' && b!=='0' && named(b)) cls.set(b,'rail');
      if (b==='0' && a!=='0' && named(a)) cls.set(a,'rail');
    }
  }
  return cls;
}
const isFlag = t => t==='gnd' || t==='rail';

// flag label for a rail net: auto-generated names (N001...) are replaced by
// the name of the DC source that drives the rail, e.g. VCE
function railLabel(net, comps){
  if (!/^n\d+$/i.test(net)) return net.toUpperCase();
  const src = comps.find(c => c.sym==='voltage'
    && /^[-+]?\d/.test(c.value) && !/SINE|PULSE|PWL|AC|EXP|SFFM/i.test(c.value)
    && ((c.nets[0]===net && c.nets[1]==='0') || (c.nets[1]===net && c.nets[0]==='0')));
  return src ? src.name.toUpperCase() : net.toUpperCase();
}

// ---------- orientation ----------
function netDepths(comps, cls){
  // BFS over signal nets starting from source outputs
  const adj = new Map(); // net -> Set(net) via shared component
  const add=(a,b)=>{ if(!adj.has(a)) adj.set(a,new Set()); adj.get(a).add(b); };
  for (const c of comps){
    const sig = c.nets.filter(n=>cls.get(n)==='signal');
    for (const a of sig) for (const b of sig) if (a!==b){ add(a,b); }
  }
  const depth = new Map(); const q=[];
  for (const c of comps){
    if (c.sym==='voltage'||c.sym==='current'){
      for (const n of c.nets) if (cls.get(n)==='signal' && !depth.has(n)){ depth.set(n,0); q.push(n); }
    }
  }
  while(q.length){
    const n=q.shift();
    for (const m of (adj.get(n)||[])) if (!depth.has(m)){ depth.set(m, depth.get(n)+1); q.push(m); }
  }
  return depth;
}

// opamp-like: 5 pins, SpiceOrder 1-2 on the left edge, 5 on the right edge
// (matches LTspice opamps and comparators: In+ In- V+ V- OUT)
function detectOp(pins){
  if (!pins || pins.length!==5) return false;
  const xs=pins.map(p=>p[0]), mn=Math.min(...xs), mx=Math.max(...xs);
  return xs[0]===mn && xs[1]===mn && xs[4]===mx && mn<mx;
}

const NOROT = (typeof process!=='undefined') && !!process.env.WEAVE_NOROT;

function chooseRotation(c, cls, depth){
  if (NOROT) return 'R0';
  if (c.isOp) return 'R0';
  if (c.sym==='voltage' || c.sym==='current') return 'R0'; // vertical, + on top
  if (c.nets.length>2) return 'R0';                        // multi-pin X blocks
  const [tA,tB] = c.nets.map(n=>cls.get(n));
  if (isFlag(tB) && !isFlag(tA)) return 'R0';    // pin1 top signal, pin2 bottom to flag
  if (isFlag(tA) && !isFlag(tB)) return 'R180';  // flip so flag pin is at bottom
  if (isFlag(tA) && isFlag(tB))  return 'R0';    // both flags (rail decoupling etc.)
  // series element: horizontal, lower-depth net on the left
  const dA = depth.get(c.nets[0]) ?? 99, dB = depth.get(c.nets[1]) ?? 99;
  // R270: pin1 -> (y,-x). res pin1 (16,16)->(16,-16), pin2 (16,96)->(96,-16): pin1 LEFT
  // R90 : pin1 -> (-16,16), pin2 -> (-96,16): pin1 RIGHT
  return (dA <= dB) ? 'R270' : 'R90';
}

// ---------- main ----------
async function convert(text, opts){
  opts = opts || {};
  const { comps, directives } = parseNetlist(text);
  const cls = classifyNets(comps);
  const depth = netDepths(comps, cls);

  for (const c of comps){
    if (!SYMBOLS[c.sym]) throw new Error('no symbol for '+c.name);
    c.isOp = detectOp(SYMBOLS[c.sym].pins);
    c.rot = chooseRotation(c, cls, depth);
    const S = SYMBOLS[c.sym];
    c.rpins = S.pins.map(p => rot(p, c.rot));
    c.rbb = rotBBox(S.bbox, c.rot);
    // widen bbox to include pins
    for (const p of c.rpins){
      c.rbb[0]=Math.min(c.rbb[0],p[0]); c.rbb[1]=Math.min(c.rbb[1],p[1]);
      c.rbb[2]=Math.max(c.rbb[2],p[0]); c.rbb[3]=Math.max(c.rbb[3],p[1]);
    }
    // outward stub direction per flag pin (from body center), then reserve
    // that space in the bbox so ELK routes signal wires around the stubs
    const cx=(c.rbb[0]+c.rbb[2])/2, cy=(c.rbb[1]+c.rbb[3])/2;
    // pin escape direction: small symbols use the dominant-axis-from-center
    // rule (keeps transistor/opamp aesthetics); large ICs escape toward the
    // NEAREST body edge, horizontal preferred on ties (side pin banks)
    const bodyBox=[c.rbb[0],c.rbb[1],c.rbb[2],c.rbb[3]];
    const big = c.rpins.length>5;
    const pinDir=(px,py)=>{
      if (SYMBOLS[c.sym] && SYMBOLS[c.sym].synthetic)
        return [px<0?-1:1, 0];   // block: left bank escapes left, right bank right
      if (!big){
        const dx=px-cx, dy=py-cy;
        return (Math.abs(dy)>=Math.abs(dx)) ? [0,Math.sign(dy||1)] : [Math.sign(dx),0];
      }
      const dl=px-bodyBox[0], dr=bodyBox[2]-px, dt=py-bodyBox[1], db=bodyBox[3]-py;
      const m=Math.min(dl,dr,dt,db);
      if (m===dr) return [1,0];
      if (m===dl) return [-1,0];
      if (m===dt) return [0,-1];
      return [0,1];
    };
    c.flagDir = c.nets.map((n,i)=>{
      if (!isFlag(cls.get(n))) return null;
      return pinDir(c.rpins[i][0], c.rpins[i][1]);
    });
    c.flagDir.forEach((d,i)=>{
      if (!d) return;
      const RES = d[0]!==0 ? 80 : 48;
      const [px,py]=c.rpins[i];
      c.rbb[0]=Math.min(c.rbb[0],px+d[0]*RES); c.rbb[1]=Math.min(c.rbb[1],py+d[1]*RES);
      c.rbb[2]=Math.max(c.rbb[2],px+d[0]*RES); c.rbb[3]=Math.max(c.rbb[3],py+d[1]*RES);
    });
    // escape stubs: signal pins get a 1-grid outward stub; ELK ports sit at
    // the stub tip so wires can never run along the symbol body edge
    c.esc = c.nets.map((n,i)=>{
      if (cls.get(n)!=='signal') return null;
      return pinDir(c.rpins[i][0], c.rpins[i][1]);
    });
    c.rtips = c.rpins.map((p,i)=> c.esc[i] ? [p[0]+c.esc[i][0]*GRID, p[1]+c.esc[i][1]*GRID] : p);
    c.esc.forEach((d,i)=>{
      if (!d) return;
      const [tx,ty]=c.rtips[i];
      c.rbb[0]=Math.min(c.rbb[0],tx); c.rbb[1]=Math.min(c.rbb[1],ty);
      c.rbb[2]=Math.max(c.rbb[2],tx); c.rbb[3]=Math.max(c.rbb[3],ty);
    });
    c.inGraph = c.nets.some(n => cls.get(n)==='signal');
  }

  // feedback elements: a two-terminal whose nets are the input and output of
  // the SAME opamp is pulled out of the graph and placed above that opamp
  const opamps = comps.filter(c=>c.isOp);
  if (!opts.noFb) for (const c of comps){
    if (c.nets.length!==2 || c.isOp) continue;
    if (!(cls.get(c.nets[0])==='signal' && cls.get(c.nets[1])==='signal')) continue;
    for (const u of opamps){
      const inIdx = [0,1].find(i => u.nets[i]===c.nets[0] || u.nets[i]===c.nets[1]);
      if (inIdx===undefined) continue;
      const inNet = u.nets[inIdx];
      const other = (c.nets[0]===inNet) ? c.nets[1] : c.nets[0];
      if (other !== u.nets[4]) continue;
      c.isFb = true; c.fbOf = u; c.fbInIdx = inIdx; c.fbInNet = inNet;
      c.rot = (c.nets[0]===inNet) ? 'R270' : 'R90'; // input-side pin on the left
      const S=SYMBOLS[c.sym];
      c.rpins = S.pins.map(p=>rot(p,c.rot));
      c.rbb = rotBBox(S.bbox,c.rot);
      for (const p of c.rpins){
        c.rbb[0]=Math.min(c.rbb[0],p[0]); c.rbb[1]=Math.min(c.rbb[1],p[1]);
        c.rbb[2]=Math.max(c.rbb[2],p[0]); c.rbb[3]=Math.max(c.rbb[3],p[1]);
      }
        c.inGraph = false;
      u.fbList = u.fbList||[]; u.fbList.push(c);
      break;
    }
  }
  // far feedback: two-terminal from an opamp's OUT net back to a lower-depth
  // upstream net (feedback across a whole stage, e.g. Sallen-Key C1);
  // stacked on tiers above the local feedback of that opamp
  if (!opts.noFar) for (const c of comps){
    if (c.isFb || c.nets.length!==2 || c.isOp) continue;
    if (!(cls.get(c.nets[0])==='signal' && cls.get(c.nets[1])==='signal')) continue;
    for (const u of opamps){
      const outIdx = c.nets.findIndex(n=>n===u.nets[4]);
      if (outIdx<0) continue;
      const upNet = c.nets[1-outIdx];
      if ((depth.get(upNet)??99) >= (depth.get(u.nets[4])??0)) continue;
      c.isFar = true; c.farOf = u; c.upNet = upNet;
      c.rot = (outIdx===1) ? 'R270' : 'R90';   // upstream pin on the left
      const S=SYMBOLS[c.sym];
      c.rpins = S.pins.map(p=>rot(p,c.rot));
      c.rbb = rotBBox(S.bbox,c.rot);
      for (const p of c.rpins){
        c.rbb[0]=Math.min(c.rbb[0],p[0]); c.rbb[1]=Math.min(c.rbb[1],p[1]);
        c.rbb[2]=Math.max(c.rbb[2],p[0]); c.rbb[3]=Math.max(c.rbb[3],p[1]);
      }
        c.inGraph = false;
      u.farList = u.farList||[]; u.farList.push(c);
      break;
    }
  }
  // divider ground/rail leg: two-terminal from an opamp's feedback input
  // net to gnd/rail, drawn horizontal in line with that input, flag at far end
  if (!opts.noLeg) for (const c of comps){
    if (c.isFb || c.nets.length!==2 || c.isOp) continue;
    const flagIdx = [0,1].find(i=>isFlag(cls.get(c.nets[i])));
    if (flagIdx===undefined) continue;
    const sigNet = c.nets[1-flagIdx];
    if (cls.get(sigNet)!=='signal') continue;
    for (const u of opamps){
      if (!u.fbList || !u.fbList.some(F=>F.fbInNet===sigNet)) continue;
      // slot left of the input must be free: no other in-graph pins on this net
      const others = comps.some(o=>o!==c && o!==u && o.inGraph && o.nets.includes(sigNet));
      if (others) break;
      c.isLeg = true; c.legOf = u;
      c.legInIdx = [0,1].find(i=>u.nets[i]===sigNet);
      c.rot = (flagIdx===0) ? 'R270' : 'R90';   // flag pin on the left
      const S=SYMBOLS[c.sym];
      c.rpins = S.pins.map(p=>rot(p,c.rot));
      c.rbb = rotBBox(S.bbox,c.rot);
      for (const p of c.rpins){
        c.rbb[0]=Math.min(c.rbb[0],p[0]); c.rbb[1]=Math.min(c.rbb[1],p[1]);
        c.rbb[2]=Math.max(c.rbb[2],p[0]); c.rbb[3]=Math.max(c.rbb[3],p[1]);
      }
        c.inGraph = false;
      u.legList = u.legList||[]; u.legList.push(c);
      break;
    }
  }
  // hangable shunt: one flag net, signal net has a real bus (>=2 other
  // in-graph pins); excluded from ELK and hung below the bus afterwards
  for (const c of comps){
    if (opts.noHang) break;
    if (c.isFb || c.isLeg || c.nets.length!==2 || c.isOp) continue;
    if (c.sym==='voltage' || c.sym==='current') continue;  // sources never hang
    const flagIdx = [0,1].find(i=>isFlag(cls.get(c.nets[i])));
    if (flagIdx===undefined) continue;
    const sigNet = c.nets[1-flagIdx];
    if (cls.get(sigNet)!=='signal') continue;
    const others = comps.filter(o=>o!==c && o.inGraph && !o.isFb && !o.isLeg && o.nets.includes(sigNet)).length;
    if (others>=1){ c.isHang=true; c.hangNet=sigNet; c.inGraph=false; }
  }
  // reserve corridors: above for feedback, left for divider legs
  for (const u of opamps){
    const tiers = (u.fbList?u.fbList.length:0) + (u.farList?u.farList.length:0);
    if (tiers){
      u.rbb[1] = Math.min(u.rbb[1], 32 - (176 + 80*(tiers-1)));
      u.rbb[2] = Math.max(u.rbb[2], 80);
      if (u.fbList && u.fbList.some(F=>F.fbInIdx===0)) u.rbb[0] = Math.min(u.rbb[0], -64);
    }
    if (u.legList) u.rbb[0] = Math.min(u.rbb[0], -160);
  }

  // ELK graph over in-graph components and signal nets
  const children=[], edges=[];
  const portId=(c,i)=>c.name+'.p'+i;
  for (const c of comps.filter(c=>c.inGraph)){
    children.push({
      id: c.name,
      width: c.rbb[2]-c.rbb[0], height: c.rbb[3]-c.rbb[1],
      layoutOptions: { 'elk.portConstraints':'FIXED_POS' },
      ports: c.rtips.map((p,i)=>({ id: portId(c,i), x: p[0]-c.rbb[0], y: p[1]-c.rbb[1], width:0, height:0 }))
    });
  }
  const nets = new Map(); // signal net -> [{c, i}]
  // same-component repeated pins on one net: only the first joins the ELK
  // graph; the rest are bridged externally tip-to-tip after placement
  // (self-edges make ELK hug the node boundary and mow down foreign tips)
  const bridges=[];   // {c, i, j}: same net, bridged externally
  for (const c of comps.filter(c=>c.inGraph)){
    const forceBridge = opts.bridge || (SYMBOLS[c.sym] && SYMBOLS[c.sym].synthetic);
    const seen=new Map();   // net -> representative pin index
    c.nets.forEach((n,i)=>{
      if (cls.get(n)!=='signal') return;
      if (forceBridge && seen.has(n)){
        const r=seen.get(n);
        const dr=c.esc[r], di=c.esc[i];
        if (dr && di && dr[0]===di[0] && dr[1]===di[1]){
          bridges.push({c, i:r, j:i});   // same escape side: bridge externally
          return;
        }
      } else if (!seen.has(n)) seen.set(n,i);
      if (!nets.has(n)) nets.set(n,[]);
      nets.get(n).push({c,i});
    });
  }
  const isDriver = ({c,i}) => (c.isOp && i===4) || ((c.sym==='voltage'||c.sym==='current') && i===0);
  // loop elements bridge distant depths (e.g. an RC across a whole stage);
  // their edges get zero straightening priority so the series chain wins
  const isLoopComp = c => c.nets.length===2 && !c.isOp &&
    Math.abs((depth.get(c.nets[0])??0)-(depth.get(c.nets[1])??0)) >= 2;
  let eid=0;
  for (const [n,pins] of nets){
    if (pins.length<2) continue;
    let a = pins.findIndex(isDriver); if (a<0) a=0;
    for (let k=0;k<pins.length;k++){
      if (k===a) continue;
      if ((opts.bridge || (SYMBOLS[pins[k].c.sym]&&SYMBOLS[pins[k].c.sym].synthetic)) && pins[k].c===pins[a].c){
        // same component on both ends: never a self-edge; route via another
        // pin if one exists, else bridge externally
        const other = pins.findIndex((q,z)=>z!==a && q.c!==pins[a].c);
        if (other>=0){
          const loop2 = isLoopComp(pins[other].c) || isLoopComp(pins[k].c);
          edges.push({ id:'e'+(eid++), netName:n,
            sources:[portId(pins[other].c,pins[other].i)], targets:[portId(pins[k].c,pins[k].i)],
            layoutOptions: loop2 ? {'elk.layered.priority.straightness':'0'} : {'elk.layered.priority.straightness':'10'} });
        } else bridges.push({c:pins[a].c, i:pins[a].i, j:pins[k].i});
        continue;
      }
      const loop = isLoopComp(pins[a].c) || isLoopComp(pins[k].c);
      edges.push({ id:'e'+(eid++), netName:n,
        sources:[portId(pins[a].c,pins[a].i)], targets:[portId(pins[k].c,pins[k].i)],
        layoutOptions: loop ? {'elk.layered.priority.straightness':'0'} : {'elk.layered.priority.straightness':'10'} });
    }
  }
  const graph = {
    id:'root',
    layoutOptions:{
      'elk.algorithm':'layered',
      'elk.direction':'RIGHT',
      'elk.spacing.nodeNode':String(Math.round(80*(opts.spacingX||1)/16)*16),
      'elk.layered.spacing.nodeNodeBetweenLayers':String(Math.round(96*(opts.spacingX||1)/16)*16),
      'elk.spacing.edgeNode':'32',
      'elk.spacing.edgeEdge':'16',
      'elk.layered.spacing.edgeEdgeBetweenLayers':'16',
      'elk.layered.spacing.edgeNodeBetweenLayers':'16',
      'elk.edgeRouting':'ORTHOGONAL',
      'elk.layered.nodePlacement.strategy':'NETWORK_SIMPLEX',
    },
    children, edges
  };
  const elk = new ELK();
  const out = await elk.layout(graph);

  // snap node positions; compute symbol origins and absolute pin coords
  const byName = new Map(comps.map(c=>[c.name,c]));
  for (const n of out.children){
    const c = byName.get(n.id);
    c.x = snap(n.x); c.y = snap(n.y);
    c.place = ()=>{
      c.origin = [c.x - c.rbb[0], c.y - c.rbb[1]];
      c.abs = c.rpins.map(p => [c.origin[0]+p[0], c.origin[1]+p[1]]);
      c.tips = c.rtips.map(p => [c.origin[0]+p[0], c.origin[1]+p[1]]);
    };
    c.place();
  }
  // nudge each opamp so its inverting (then noninverting) input row lines up
  // with the series element feeding it, letting the feeder enter dead straight
  for (const u of opamps.filter(u=>u.inGraph)){
    for (const inIdx of [1,0]){
      const pid = u.name+'.p'+inIdx;
      const e = (out.edges||[]).find(e=>e.targets[0]===pid);
      if (!e) continue;
      const src = comps.find(c=>c.inGraph && e.sources[0].startsWith(c.name+'.p'));
      if (!src || src.nets.length!==2) continue;
      const si = +e.sources[0].split('.p')[1];
      const delta = src.tips[si][1] - u.tips[inIdx][1];
      if (delta!==0 && Math.abs(delta)<=32 && delta%GRID===0){ u.y += delta; u.place(); }
      break;
    }
  }
  // supply corner for out-of-graph components (all pins flags)
  // wires from ELK edge sections, snapped, endpoints forced onto stub tips
  const wires=[];
  const portAbs = new Map();
  for (const c of comps.filter(c=>c.inGraph)){
    c.tips.forEach((p,i)=>portAbs.set(portId(c,i),p));
    // emit the escape stubs themselves (tagged with their net)
    c.esc.forEach((d,i)=>{
      if (d) wires.push([c.abs[i][0],c.abs[i][1],c.tips[i][0],c.tips[i][1],c.nets[i]]);
    });
  }
  // feedback elements: centered above their opamp, classic LTspice loop shape
  const fbJobs=[];
  for (const u of opamps){
    if (!u.fbList) continue;
    const cx = u.origin[0];                       // opamp symbol origin x = body center
    const bodyTop = u.origin[1] + 32;             // V+ pin row = top of triangle
    u.fbList.forEach((F,k)=>{
      const yF = bodyTop - 128 - 80*k;
      const left  = F.rpins[0][0] < F.rpins[1][0] ? 0 : 1;
      const right = 1 - left;
      // origin so that the left pin lands at (cx-48, yF)
      F.origin = [cx-48 - F.rpins[left][0], yF - F.rpins[left][1]];
      F.abs = F.rpins.map(p=>[F.origin[0]+p[0], F.origin[1]+p[1]]);
      F.x = F.origin[0]+F.rbb[0]; F.y = F.origin[1]+F.rbb[1];
      const inPin  = u.abs[F.fbInIdx], inTip  = u.tips[F.fbInIdx];
      const outTip = u.tips[4];
      // input side: drop at x=inTip.x if that is a clear column (In-),
      // otherwise one grid further left with a final jog (In+ passes In- tip)
      fbJobs.push({F,u,yF,left,right,inPin,inTip,outTip});
    });
  }
  // divider legs: right pin lands exactly on the input stub tip
  for (const u of opamps){
    if (!u.legList) continue;
    u.legList.forEach(Lg=>{
      const tip = u.tips[Lg.legInIdx];
      const right = Lg.rpins[0][0] < Lg.rpins[1][0] ? 1 : 0;
      Lg.origin = [tip[0]-Lg.rpins[right][0], tip[1]-Lg.rpins[right][1]];
      Lg.abs = Lg.rpins.map(p=>[Lg.origin[0]+p[0], Lg.origin[1]+p[1]]);
      Lg.x = Lg.origin[0]+Lg.rbb[0]; Lg.y = Lg.origin[1]+Lg.rbb[1];
    });
  }
  const routes=[];
  for (const e of (out.edges||[])){
    for (const s of (e.sections||[])){
      let pts = [s.startPoint, ...(s.bendPoints||[]), s.endPoint].map(p=>[snap(p.x),snap(p.y)]);
      const A = portAbs.get(e.sources[0]), B = portAbs.get(e.targets[0]);
      fixEnd(pts, 0, A); fixEnd(pts, pts.length-1, B);
      // fixEnd on short routes can detach one end (the two adjustments can
      // fight over a shared neighbor); force both ends onto their tips and
      // restore orthogonality by inserting corners at diagonal adjacencies
      pts[0]=[A[0],A[1]]; pts[pts.length-1]=[B[0],B[1]];
      for (let k=0;k+1<pts.length;k++){
        const a=pts[k], b=pts[k+1];
        if (a[0]!==b[0] && a[1]!==b[1]) pts.splice(k+1,0,[a[0],b[1]]);
      }
      for (let k=pts.length-2;k>=0;k--)
        if (pts[k][0]===pts[k+1][0] && pts[k][1]===pts[k+1][1]) pts.splice(k+1,1);
      // orthogonalize any residual diagonal by inserting an L bend
      const path=[pts[0]];
      for (let i=1;i<pts.length;i++){
        const p=path[path.length-1], q=pts[i];
        if (p[0]!==q[0] && p[1]!==q[1]) path.push([q[0],p[1]]);
        path.push(q);
      }
      routes.push({net:e.netName, pts:path});
    }
  }
  // external bridges for same-component repeated-net pins: run each tip one
  // grid further out along its own escape, then connect the two extended
  // points with an L that stays outside the body bbox
  for (const B of bridges){
    const c=B.c, n=c.nets[B.i];
    const tA=c.tips[B.i], tB=c.tips[B.j];
    const dA=c.esc[B.i]||[1,0], dB=c.esc[B.j]||[1,0];
    // push each tip out by one extra grid so the corner clears the stub tips
    const eA=[tA[0]+dA[0]*GRID, tA[1]+dA[1]*GRID];
    const eB=[tB[0]+dB[0]*GRID, tB[1]+dB[1]*GRID];
    wires.push([tA[0],tA[1],eA[0],eA[1],n]);
    wires.push([tB[0],tB[1],eB[0],eB[1],n]);
    // body bbox in absolute coords
    const bb=[c.origin[0]+c.rbb[0], c.origin[1]+c.rbb[1],
              c.origin[0]+c.rbb[2], c.origin[1]+c.rbb[3]];
    // choose a routing X outside the body on the side both tips can reach;
    // if the two escapes point the same way, a simple L suffices
    if (dA[0]===dB[0] && dA[1]===dB[1]){
      c.__lane = (c.__lane||0)+1;
      if (dA[0]!==0){ // horizontal escapes: vertical bus at the further X
        const bx=(dA[0]>0?Math.max(eA[0],eB[0]):Math.min(eA[0],eB[0]))+dA[0]*GRID*(c.__lane-1);
        wires.push([eA[0],eA[1],bx,eA[1],n]);
        wires.push([bx,eA[1],bx,eB[1],n]);
        wires.push([bx,eB[1],eB[0],eB[1],n]);
      } else {
        const by=(dA[1]>0?Math.max(eA[1],eB[1]):Math.min(eA[1],eB[1]))+dA[1]*GRID*(c.__lane-1);
        wires.push([eA[0],eA[1],eA[0],by,n]);
        wires.push([eA[0],by,eB[0],by,n]);
        wires.push([eB[0],by,eB[0],eB[1],n]);
      }
    } else {
      // escapes point different ways: detour around top or bottom of the body.
      // Each such bridge on this component gets its own lane so they cannot
      // stack onto a shared Y. Lane index tracked per component+edge.
      c.__lane = (c.__lane||0)+1;
      const topPref = (Math.abs(eA[1]-bb[1])+Math.abs(eB[1]-bb[1]) <=
                       Math.abs(eA[1]-bb[3])+Math.abs(eB[1]-bb[3]));
      const outY = topPref ? bb[1]-GRID*c.__lane : bb[3]+GRID*c.__lane;
      // extend each tip vertically to the lane, but first step horizontally
      // out to a unique X per side so parallel verticals do not overlap
      wires.push([eA[0],eA[1],eA[0],outY,n]);
      wires.push([eA[0],outY,eB[0],outY,n]);
      wires.push([eB[0],outY,eB[0],eB[1],n]);
    }
  }
  // deconflict: an ELK route segment passing through a FOREIGN stub tip
  // would create a junction (LTspice connects wire endpoints touching a
  // wire); displace such segments one grid outward past the tip
  {
    const tipPts=[];
    for (const c of comps.filter(c=>c.inGraph))
      c.tips.forEach((p,i)=>{ if (c.esc[i]) tipPts.push({x:p[0],y:p[1],net:c.nets[i],d:c.esc[i]}); });
    for (const r of routes){
      for (let pass=0; pass<2; pass++){
        let changed=false;
        for (let i=0;i+1<r.pts.length;i++){
          const a=r.pts[i], b=r.pts[i+1];
          for (const t of tipPts){
            if (t.net===r.net) continue;
            const vert = a[0]===b[0];
            const inside = vert
              ? (t.x===a[0] && t.y>Math.min(a[1],b[1]) && t.y<Math.max(a[1],b[1]))
              : (t.y===a[1] && t.x>Math.min(a[0],b[0]) && t.x<Math.max(a[0],b[0]));
            if (!inside) continue;
            const sh = GRID;
            if (vert){
              const nx = a[0] + (t.d[0]!==0 ? t.d[0]*sh : sh);
              r.pts.splice(i+1, 0, [nx,a[1]], [nx,b[1]]);
            } else {
              const ny = a[1] + (t.d[1]!==0 ? t.d[1]*sh : sh);
              r.pts.splice(i+1, 0, [a[0],ny], [b[0],ny]);
            }
            changed=true; break;
          }
          if (changed) break;
        }
        if (!changed) break;
      }
    }
  }
  const allSegs = () => {
    const list=[...wires];
    for (const r of routes) for (let i=1;i<r.pts.length;i++)
      list.push([r.pts[i-1][0],r.pts[i-1][1],r.pts[i][0],r.pts[i][1],r.net]);
    return list;
  };
  // feedback wiring, deferred until ELK routes are known so the input
  // drop can pick a column that is not already a foreign routing channel
  const segTouchesForeign=(seg,net)=>{
    const list=allSegs();
    for (const w of list){
      if (w[4]===net) continue;
      const ax1=Math.min(seg[0],seg[2]),ax2=Math.max(seg[0],seg[2]);
      const ay1=Math.min(seg[1],seg[3]),ay2=Math.max(seg[1],seg[3]);
      // collinear overlap or endpoint-on-interior in either direction
      const vertA=seg[0]===seg[2], vertW=w[0]===w[2];
      if (vertA&&vertW&&seg[0]===w[0]&&Math.max(ay1,Math.min(w[1],w[3]))<Math.min(ay2,Math.max(w[1],w[3]))) return true;
      if (!vertA&&!vertW&&seg[1]===w[1]&&Math.max(ax1,Math.min(w[0],w[2]))<Math.min(ax2,Math.max(w[0],w[2]))) return true;
      const onSeg=(x,y,g)=>{
        if ((x===g[0]&&y===g[1])||(x===g[2]&&y===g[3])) return false;
        if (g[0]===g[2]) return x===g[0]&&y>Math.min(g[1],g[3])&&y<Math.max(g[1],g[3]);
        if (g[1]===g[3]) return y===g[1]&&x>Math.min(g[0],g[2])&&x<Math.max(g[0],g[2]);
        return false;
      };
      if (onSeg(w[0],w[1],seg)||onSeg(w[2],w[3],seg)) return true;
      if (onSeg(seg[0],seg[1],w)||onSeg(seg[2],seg[3],w)) return true;
    }
    return false;
  };
  for (const J of fbJobs){
    const {F,u,yF,left,right,inPin,inTip,outTip} = J;
    const nin = F.fbInNet, nout = u.nets[4];
    const base = (F.fbInIdx===1) ? inTip[0] : inTip[0]-GRID;
    let xDrop = base;
    for (const cand of [base, base-GRID, base-2*GRID, base+GRID, base-3*GRID]){
      const v=[cand,yF,cand,inPin[1],nin];
      if (!segTouchesForeign(v,nin)){ xDrop=cand; break; }
    }
    wires.push([F.abs[left][0],yF, xDrop,yF, nin]);
    wires.push([xDrop,yF, xDrop,inPin[1], nin]);
    if (xDrop!==inTip[0]) wires.push([xDrop,inPin[1], inTip[0],inPin[1], nin]);
    const xOut = u.abs[4][0] + 48;
    wires.push([F.abs[right][0],yF, xOut,yF, nout]);
    wires.push([xOut,yF, xOut,u.abs[4][1], nout]);
    wires.push([xOut,u.abs[4][1], outTip[0],u.abs[4][1], nout]);
  }
  // far feedback: tiers above local fb, dropping onto the upstream bus
  for (const u of opamps){
    if (!u.farList) continue;
    const base = u.fbList ? u.fbList.length : 0;
    const bodyTop = u.origin[1] + 32;
    const xOut = u.abs[4][0] + 48;
    u.farList.forEach((F,j)=>{
      const yF = bodyTop - 128 - 80*(base+j);
      // junction: horizontal wire of upNet closest below the tier
      // candidate junctions: horizontal runs of the upstream net BELOW the
      // tier (drops go down); pick the first whose drop column is clean
      const runs = allSegs().filter(w=>w[4]===F.upNet && w[1]===w[3] && w[1]>yF);
      runs.sort((a,b)=>Math.abs(a[1]-yF)-Math.abs(b[1]-yF));
      let xj=null, yj=null;
      const dropClean=(x,y)=>!allSegs().some(w=>{
        if (w[4]===F.upNet || w[4]===u.nets[4]) return false;
        if (w[0]===w[2] && w[0]===x &&
            Math.max(yF,Math.min(w[1],w[3]))<Math.min(y,Math.max(w[1],w[3]))) return true;
        return false;
      });
      for (const R of runs){
        const lo=Math.min(R[0],R[2]), hi=Math.max(R[0],R[2]);
        for (const cx2 of [snap((lo+hi)/2), lo+GRID>hi?lo:lo+GRID, hi-GRID<lo?hi:hi-GRID,
                           snap(lo+(hi-lo)*0.25), snap(lo+(hi-lo)*0.75)]){
          if (cx2>=lo && cx2<=hi && dropClean(cx2,R[1])){ xj=cx2; yj=R[1]; break; }
        }
        if (xj!==null) break;
      }
      if (xj===null && runs.length){
        const R=runs[0];
        xj=snap((Math.min(R[0],R[2])+Math.max(R[0],R[2]))/2); yj=R[1];
      }
      if (xj===null){
        const o = comps.find(o=>o.inGraph && o.nets.includes(F.upNet));
        const i = o.nets.indexOf(F.upNet);
        xj = o.tips[i][0]; yj = o.tips[i][1];
      }
      const left = F.rpins[0][0] < F.rpins[1][0] ? 0 : 1, right = 1-left;
      F.origin = [xj - F.rpins[left][0], yF - F.rpins[left][1]];
      F.abs = F.rpins.map(p=>[F.origin[0]+p[0], F.origin[1]+p[1]]);
      F.x = F.origin[0]+F.rbb[0]; F.y = F.origin[1]+F.rbb[1];
      wires.push([xj,yF, xj,yj, F.upNet]);                       // drop to bus
      wires.push([F.abs[right][0],yF, xOut,yF, u.nets[4]]);      // tier run
      wires.push([xOut,yF, xOut,u.abs[4][1], u.nets[4]]);        // down out column
      wires.push([xOut,u.abs[4][1], u.tips[4][0],u.abs[4][1], u.nets[4]]);
    });
  }
  // hang shunts below the longest horizontal run of their bus
  const segRectHit = (w,r)=>{ // orthogonal segment vs rect [x1,y1,x2,y2]
    const [ax,ay,bx,by]=w;
    const x1=Math.min(ax,bx), x2=Math.max(ax,bx), y1=Math.min(ay,by), y2=Math.max(ay,by);
    return !(x2<r[0]||x1>r[2]||y2<r[1]||y1>r[3]);
  };
  const segSegTouch=(a,b)=>{ // do two orthogonal segments share any point
    const ax1=Math.min(a[0],a[2]),ax2=Math.max(a[0],a[2]),ay1=Math.min(a[1],a[3]),ay2=Math.max(a[1],a[3]);
    const bx1=Math.min(b[0],b[2]),bx2=Math.max(b[0],b[2]),by1=Math.min(b[1],b[3]),by2=Math.max(b[1],b[3]);
    return !(ax2<bx1||ax1>bx2||ay2<by1||ay1>by2);
  };
  const tipUse=new Map();
  for (const c of comps.filter(c=>c.isHang)){
    const bus = allSegs().filter(w=>w[4]===c.hangNet && w[1]===w[3] && Math.abs(w[2]-w[0])>=GRID);
    const maxRun = bus.reduce((m,w)=>Math.max(m,Math.abs(w[2]-w[0])),0);
    if (!bus.length || maxRun < 48){
      // no horizontal run on the net: extend along the partner pin's stub
      // (pull-up style), signal pin on the stub tip, flag at the far end
      const o = comps.find(o=>o.inGraph && o.nets.includes(c.hangNet));
      if (!o){ throw new Error(c.name+': net '+c.hangNet+' has no placed partner'); }
      const i = o.nets.indexOf(c.hangNet);
      const tip = o.tips[i], dir = o.esc[i] || [0,-1];
      const tk = tip[0]+','+tip[1];
      tipUse.set(tk, (tipUse.get(tk)||0)+1);
      const k = tipUse.get(tk)-1;                 // 0: extend, 1+: fan out
      const sigIdx = c.nets.findIndex(n=>n===c.hangNet);
      // fan-out connector must not touch other nets or bodies: try both
      // perpendiculars and the outward stack, take the first clean one
      let base=[tip[0],tip[1]];
      if (k>0){
        const others=allSegs().filter(w=>w[4]!==c.hangNet);
        // tight symbol bodies (not corridor-inflated boxes), partner excluded:
        // the connector legitimately starts on the partner's inflated boundary
        const bodies=comps.filter(o2=>o2.origin && o2!==c && o2!==o).map(o2=>{
          const r=rotBBox(SYMBOLS[o2.sym].bbox, o2.rot);
          return [o2.origin[0]+r[0], o2.origin[1]+r[1], o2.origin[0]+r[2], o2.origin[1]+r[3]];
        });
        const clean=b=>{
          const seg=[tip[0],tip[1],b[0],b[1]];
          if (others.some(w=>segSegTouch(seg,w))) return false;
          if (bodies.some(r=>segRectHit(seg,r))) return false;
          return true;
        };
        const cand=[
          [tip[0]-dir[1]*k*96, tip[1]+dir[0]*k*96],
          [tip[0]+dir[1]*k*96, tip[1]-dir[0]*k*96],
          [tip[0]+dir[0]*k*112, tip[1]+dir[1]*k*112],
        ];
        base = cand.find(clean) || cand[0];
      }
      // orientation: signal pin faces back toward the tip, body extends along dir
      let rotc;
      if (dir[1]===-1) rotc = (sigIdx===0)?'R180':'R0';   // extends upward
      else if (dir[1]===1) rotc = (sigIdx===0)?'R0':'R180';
      else if (dir[0]===1) rotc = (sigIdx===0)?'R270':'R90';
      else rotc = (sigIdx===0)?'R90':'R270';
      c.rot=rotc;
      const S=SYMBOLS[c.sym];
      c.rpins=S.pins.map(p=>rot(p,c.rot));
      c.rbb=rotBBox(S.bbox,c.rot);
      for (const p of c.rpins){
        c.rbb[0]=Math.min(c.rbb[0],p[0]); c.rbb[1]=Math.min(c.rbb[1],p[1]);
        c.rbb[2]=Math.max(c.rbb[2],p[0]); c.rbb[3]=Math.max(c.rbb[3],p[1]);
      }
      const pinPt=[base[0]+dir[0]*GRID, base[1]+dir[1]*GRID];
      c.origin=[pinPt[0]-c.rpins[sigIdx][0], pinPt[1]-c.rpins[sigIdx][1]];
      c.abs=c.rpins.map(p=>[c.origin[0]+p[0],c.origin[1]+p[1]]);
      c.x=c.origin[0]+c.rbb[0]; c.y=c.origin[1]+c.rbb[1];
      c.flagDir=c.nets.map((n,i2)=> i2===sigIdx ? null : dir);
      if (k>0) wires.push([tip[0],tip[1], base[0],base[1], c.hangNet]);
      wires.push([base[0],base[1], pinPt[0],pinPt[1], c.hangNet]);
      continue;
    }
    const sigIdx = c.nets.findIndex(n=>n===c.hangNet);
    const oxs = opamps.filter(u=>u.origin).map(u=>u.origin[0]);
    const cands=[]; // [x, y0, hostSeg], farthest from any opamp first
    for (const B of bus){
      const xl=Math.min(B[0],B[2]), xr=Math.max(B[0],B[2]);
      for (const x of new Set([snap((xl+xr)/2), snap(xl+(xr-xl)*0.25), snap(xl+(xr-xl)*0.75), xl+GRID>xr?xl:xl+GRID, xr-GRID<xl?xr:xr-GRID]))
        if (x>=xl && x<=xr) cands.push([x, B[1], B]);
    }
    cands.sort((a,b)=>{
      const da=Math.min(...oxs.map(o=>Math.abs(a[0]-o)), 1e9);
      const db=Math.min(...oxs.map(o=>Math.abs(b[0]-o)), 1e9);
      return db-da;
    });
    const placed = comps.filter(o=>o.origin && o!==c);
    // gnd elements hang below the bus, rail elements sit above it
    const flagIdx2 = c.nets.findIndex(n=>isFlag(cls.get(n)));
    const dirSign = (cls.get(c.nets[flagIdx2])==='rail') ? -1 : 1;
    if (dirSign<0){ // flip so the flag pin points up
      c.rot = (c.rot==='R0') ? 'R180' : (c.rot==='R180' ? 'R0' : c.rot);
      const S=SYMBOLS[c.sym];
      c.rpins = S.pins.map(p=>rot(p,c.rot));
      c.rbb = rotBBox(S.bbox,c.rot);
      for (const p of c.rpins){
        c.rbb[0]=Math.min(c.rbb[0],p[0]); c.rbb[1]=Math.min(c.rbb[1],p[1]);
        c.rbb[2]=Math.max(c.rbb[2],p[0]); c.rbb[3]=Math.max(c.rbb[3],p[1]);
      }
      c.flagDir = c.nets.map((n,i2)=> i2===flagIdx2 ? [0,-1] : null);
    }
    let done=false;
    for (const [x,y0,B] of cands){
      const topPin=[x, y0+dirSign*GRID];
      const origin=[topPin[0]-c.rpins[sigIdx][0], topPin[1]-c.rpins[sigIdx][1]];
      const oy1=origin[1]+c.rbb[1], oy2=origin[1]+c.rbb[3];
      const rect=[origin[0]+c.rbb[0]-GRID,
                  dirSign>0 ? y0+1 : oy1-GRID,
                  origin[0]+c.rbb[2]+GRID,
                  dirSign>0 ? oy2+GRID : y0-1];
      const drop=[x,y0, x,y0+dirSign*GRID];
      const clash = allSegs().some(w=>!(w[0]===B[0]&&w[1]===B[1]&&w[2]===B[2]&&w[3]===B[3]) && (segRectHit(w,rect)||segSegTouch(w,drop)))
        || placed.some(o=>{
             const R=[o.origin[0]+o.rbb[0], o.origin[1]+o.rbb[1], o.origin[0]+o.rbb[2], o.origin[1]+o.rbb[3]];
             return !(R[2]<rect[0]||R[0]>rect[2]||R[3]<rect[1]||R[1]>rect[3]);
           });
      if (clash) continue;
      c.origin=origin;
      c.abs=c.rpins.map(p=>[origin[0]+p[0],origin[1]+p[1]]);
      c.x=origin[0]+c.rbb[0]; c.y=origin[1]+c.rbb[1];
      wires.push([x,y0,x,y0+dirSign*GRID,c.hangNet]);
      done=true; break;
    }
    if (!done){ // no clean slot: take the best-ranked candidate anyway
      const [x,y0]=cands[0], topPin=[x,y0+dirSign*GRID];
      c.origin=[topPin[0]-c.rpins[sigIdx][0], topPin[1]-c.rpins[sigIdx][1]];
      c.abs=c.rpins.map(p=>[c.origin[0]+p[0],c.origin[1]+p[1]]);
      c.x=c.origin[0]+c.rbb[0]; c.y=c.origin[1]+c.rbb[1];
      wires.push([x,y0,x,y0+dirSign*GRID,c.hangNet]);
    }
  }
  // supply corner: placed after everything else, below the true extent
  {
    let maxY = 0;
    for (const c of comps.filter(c=>c.origin)) maxY=Math.max(maxY, c.origin[1]+c.rbb[3]);
    for (const w of allSegs()) maxY=Math.max(maxY, w[1], w[3]);
    let sx = 0;
    for (const c of comps.filter(c=>!c.inGraph && !c.isFb && !c.isLeg && !c.isHang && !c.isFar)){
      c.x = snap(sx); c.y = snap(maxY+96);
      c.origin = [c.x-c.rbb[0], c.y-c.rbb[1]];
      c.abs = c.rpins.map(p=>[c.origin[0]+p[0], c.origin[1]+p[1]]);
      sx += (c.rbb[2]-c.rbb[0]) + 96;
    }
  }
  // L-simplification: a multi-bend two-point route becomes a single-corner L
  // when the L is provably clean (no symbol bodies, no other-net contact)
  const bodyRects = () => comps.filter(c=>c.origin).map(c=>{
    const b=SYMBOLS[c.sym].bbox, r=rotBBox(b,c.rot);
    return {c, r:[c.origin[0]+r[0]+2, c.origin[1]+r[1]+2, c.origin[0]+r[2]-2, c.origin[1]+r[3]-2]};
  });
  const ptOnSeg=(p,w)=>{
    if (w[0]===w[2]) return p[0]===w[0] && p[1]>=Math.min(w[1],w[3]) && p[1]<=Math.max(w[1],w[3]);
    if (w[1]===w[3]) return p[1]===w[1] && p[0]>=Math.min(w[0],w[2]) && p[0]<=Math.max(w[0],w[2]);
    return false;
  };
  const collinearOverlap=(a,b)=>{
    if (a[0]===a[2] && b[0]===b[2] && a[0]===b[0])
      return Math.max(Math.min(a[1],a[3]),Math.min(b[1],b[3])) < Math.min(Math.max(a[1],a[3]),Math.max(b[1],b[3]));
    if (a[1]===a[3] && b[1]===b[3] && a[1]===b[1])
      return Math.max(Math.min(a[0],a[2]),Math.min(b[0],b[2])) < Math.min(Math.max(a[0],a[2]),Math.max(b[0],b[2]));
    return false;
  };
  function lClean(segs, net, allSegs, rects){
    for (const g of segs){
      for (const {r} of rects){
        const x1=Math.min(g[0],g[2]),x2=Math.max(g[0],g[2]),y1=Math.min(g[1],g[3]),y2=Math.max(g[1],g[3]);
        if (!(x2<r[0]||x1>r[2]||y2<r[1]||y1>r[3])) return false;
      }
      for (const w of allSegs){
        if (w[4]===net) continue;
        if (collinearOverlap(g,w)) return false;
        if (ptOnSeg([w[0],w[1]],g) || ptOnSeg([w[2],w[3]],g)) return false;
        if (ptOnSeg([g[0],g[1]],w) || ptOnSeg([g[2],g[3]],w)) return false;
      }
    }
    return true;
  }
  {
    const rects = bodyRects();
    const others = net => {
      const list=[...wires];
      for (const r of routes) for (let i=1;i<r.pts.length;i++)
        list.push([r.pts[i-1][0],r.pts[i-1][1],r.pts[i][0],r.pts[i][1],r.net]);
      return list;
    };
    for (const r of routes){
      if (opts.noLPass) break;
      if (r.pts.length<=3) continue;   // already straight or single-corner
      const P=r.pts[0], Q=r.pts[r.pts.length-1];
      const all=others(r.net);
      for (const corner of [[P[0],Q[1]],[Q[0],P[1]]]){
        const segs=[[P[0],P[1],corner[0],corner[1]],[corner[0],corner[1],Q[0],Q[1]]]
          .filter(g=>g[0]!==g[2]||g[1]!==g[3]);
        if (lClean(segs, r.net, all, rects)){ r.pts=[P,corner,Q]; break; }
      }
    }
    for (const r of routes) for (let i=1;i<r.pts.length;i++){
      const p=r.pts[i-1], q=r.pts[i];
      if (p[0]!==q[0]||p[1]!==q[1]) wires.push([p[0],p[1],q[0],q[1],r.net]);
    }
  }
  function fixEnd(pts, idx, target){
    if (!target) return;
    const other = idx===0 ? 1 : pts.length-2;
    const p = pts[idx];
    if (pts.length>=2){
      const q = pts[other];
      if (q[1]===p[1]) q[1]=target[1]; else if (q[0]===p[0]) q[0]=target[0];
    }
    pts[idx]=[target[0],target[1]];
  }

  // universal cross-net contact guard: after ALL wires exist, any two
  // segments of different nets that overlap collinearly or meet at an
  // endpoint-on-interior get separated by a one-grid bump on one of them
  {
    const key=w=>w[4]||'';
    const isV=w=>w[0]===w[2];
    const inInt=(x,y,w)=>{
      if ((x===w[0]&&y===w[1])||(x===w[2]&&y===w[3])) return false;
      if (isV(w)) return x===w[0] && y>Math.min(w[1],w[3]) && y<Math.max(w[1],w[3]);
      if (w[1]===w[3]) return y===w[1] && x>Math.min(w[0],w[2]) && x<Math.max(w[0],w[2]);
      return false;
    };
    const colOverlap=(a,b)=>{
      if (isV(a)&&isV(b)&&a[0]===b[0]){
        const lo=Math.max(Math.min(a[1],a[3]),Math.min(b[1],b[3]));
        const hi=Math.min(Math.max(a[1],a[3]),Math.max(b[1],b[3]));
        if (lo<hi) return [a[0],lo,a[0],hi];
      }
      if (!isV(a)&&!isV(b)&&a[1]===b[1]&&a[1]===b[3]){
        const lo=Math.max(Math.min(a[0],a[2]),Math.min(b[0],b[2]));
        const hi=Math.min(Math.max(a[0],a[2]),Math.max(b[0],b[2]));
        if (lo<hi) return [lo,a[1],hi,a[1]];
      }
      return null;
    };
    const anyContact=(seg,net)=>wires.some(w=>{
      if (key(w)===net) return false;
      if (colOverlap(seg,w)) return true;
      if (inInt(w[0],w[1],seg)||inInt(w[2],w[3],seg)) return true;
      if (inInt(seg[0],seg[1],w)||inInt(seg[2],seg[3],w)) return true;
      return false;
    });
    // bump wire w around span [p1,p2] (inclusive margin m), offset off
    const bump=(idx,lo,hi,off)=>{
      const w=wires[idx], net=w[4];
      const m=GRID;
      if (isV(w)){
        const x=w[0], y1=Math.min(w[1],w[3]), y2=Math.max(w[1],w[3]);
        const a=Math.max(y1, lo-m), b=Math.min(y2, hi+m);
        const nx=x+off;
        const parts=[[x,y1,x,a,net],[x,a,nx,a,net],[nx,a,nx,b,net],[nx,b,x,b,net],[x,b,x,y2,net]];
        const clean=parts.slice(1,4).every(g=>!anyContact(g,net));
        if (!clean) return false;
        wires.splice(idx,1,...parts.filter(g=>g[0]!==g[2]||g[1]!==g[3]));
        return true;
      } else {
        const y=w[1], x1=Math.min(w[0],w[2]), x2=Math.max(w[0],w[2]);
        const a=Math.max(x1, lo-m), b=Math.min(x2, hi+m);
        const ny=y+off;
        const parts=[[x1,y,a,y,net],[a,y,a,ny,net],[a,ny,b,ny,net],[b,ny,b,y,net],[b,y,x2,y,net]];
        const clean=parts.slice(1,4).every(g=>!anyContact(g,net));
        if (!clean) return false;
        wires.splice(idx,1,...parts.filter(g=>g[0]!==g[2]||g[1]!==g[3]));
        return true;
      }
    };
    for (let round=0; round<24; round++){
      let fixed=false;
      outer:
      for (let i=0;i<wires.length;i++){
        for (let j=0;j<wires.length;j++){
          if (i===j) continue;
          const A=wires[i], B=wires[j];
          if (key(A)===key(B) || !key(A) || !key(B)) continue;
          const ov=colOverlap(A,B);
          let lo,hi,vert=isV(A);
          if (ov){ lo=vert?ov[1]:ov[0]; hi=vert?ov[3]:ov[2]; }
          else {
            let pt=null;
            if (inInt(B[0],B[1],A)) pt=[B[0],B[1]];
            else if (inInt(B[2],B[3],A)) pt=[B[2],B[3]];
            if (!pt) continue;
            lo=hi=vert?pt[1]:pt[0];
          }
          for (const off of [GRID,-GRID,2*GRID,-2*GRID,3*GRID,-3*GRID]){
            if (bump(i,lo,hi,off)){ fixed=true; break outer; }
          }
          // the first wire may be boxed in: try displacing the other one
          {
            const vert2=isV(B);
            let lo2=lo, hi2=hi;
            if (!ov){
              let pt=null;
              if (inInt(A[0],A[1],B)) pt=[A[0],A[1]];
              else if (inInt(A[2],A[3],B)) pt=[A[2],A[3]];
              if (pt){ lo2=hi2=vert2?pt[1]:pt[0]; }
              else { lo2=vert2?Math.min(B[1],B[3]):Math.min(B[0],B[2]);
                     hi2=vert2?Math.max(B[1],B[3]):Math.max(B[0],B[2]); }
            }
            for (const off of [GRID,-GRID,2*GRID,-2*GRID,3*GRID,-3*GRID]){
              if (bump(j,lo2,hi2,off)){ fixed=true; break outer; }
            }
          }
        }
      }
      if (!fixed) break;
    }
  }
  // flags on pins whose net is gnd/rail, with a 32-unit outward stub
  const flags=[];
  for (const c of comps){
    c.nets.forEach((n,i)=>{
      const t = cls.get(n);
      if (t!=='gnd' && t!=='rail') return;
      if (!c.abs) throw new Error(c.name+': component was never placed (internal)');
      const [px,py]=c.abs[i];
      if (c.isLeg){ flags.push([px,py, t==='gnd' ? '0' : railLabel(n,comps)]); return; }
      const d = c.flagDir[i] || [0,1];
      const L = d[0]!==0 ? 64 : 32;   // horizontal stubs longer: clear the labels
      const ex = px + d[0]*L, ey = py + d[1]*32;
      wires.push([px,py,ex,ey, 'FLAG:'+(t==='gnd'?'0':railLabel(n,comps))]);
      flags.push([ex,ey, t==='gnd' ? '0' : railLabel(n,comps)]);
    });
  }

  // emit .asc
  const L=['Version 4','SHEET 1 1200 800'];
  for (const w of wires) if (w[0]!==w[2]||w[1]!==w[3]) L.push(`WIRE ${w[0]} ${w[1]} ${w[2]} ${w[3]}`);
  for (const f of flags) L.push(`FLAG ${f[0]} ${f[1]} ${f[2]}`);
  for (const c of comps){
    L.push(`SYMBOL ${c.sym} ${c.origin[0]} ${c.origin[1]} ${c.rot}`);
    // LTspice's editor rewrites label windows on rotation so text stays
    // horizontal (ground truth: Draft5.asc); reproduce that per rotation
    if (c.nets.length===2 && c.rot!=='R0' && !NOROT){
      const b = SYMBOLS[c.sym].bbox;
      const my = Math.round((b[1]+b[3])/2/8)*8;
      const w = SYMBOLS[c.sym].windows || {};
      const d0 = w['0']||[36,40,'Left'], d3 = w['3']||[36,76,'Left'];
      if (c.rot==='R90' || c.rot==='R270'){
        // name above the body; value below by LTspice convention, but if a
        // wire runs under the element, stack the value above the name instead
        const vlen = Math.min((''+(c.value||'')).length, 24)*16;
        const below = rot(c.rot==='R90' ? [b[2],my] : [b[0],my], c.rot);
        const bax = c.origin[0]+below[0], bay = c.origin[1]+below[1];
        const box = [bax-vlen/2, bay, bax+vlen/2, bay+28];
        const hit = wires.some(w=>{
          const x1=Math.min(w[0],w[2]), x2=Math.max(w[0],w[2]);
          const y1=Math.min(w[1],w[3]), y2=Math.max(w[1],w[3]);
          return !(x2<box[0]||x1>box[2]||y2<box[1]||y1>box[3]);
        });
        if (c.rot==='R90'){
          L.push(`WINDOW 0 ${b[0]} ${my} VBottom 2`);
          L.push(hit ? `WINDOW 3 ${b[0]-32} ${my} VBottom 2`
                     : `WINDOW 3 ${b[2]} ${my} VTop 2`);
        } else {
          L.push(`WINDOW 0 ${b[2]} ${my} VTop 2`);
          L.push(hit ? `WINDOW 3 ${b[2]+32} ${my} VTop 2`
                     : `WINDOW 3 ${b[0]} ${my} VBottom 2`);
        }
      } else if (c.rot==='R180'){
        L.push(`WINDOW 0 ${d3[0]} ${d3[1]} Left 2`);
        L.push(`WINDOW 3 ${d0[0]} ${d0[1]} Left 2`);
      }
    }
    L.push(`SYMATTR InstName ${c.name}`);
    if (c.value){
      const m = c.value.match(/^(.*?)(\s+AC\s+.*)?$/i);
      L.push(`SYMATTR Value ${m[1]}`);
      if (m[2]) L.push(`SYMATTR Value2 ${m[2].trim()}`);
    }
  }
  let ty = Math.max(0,...comps.map(c=>c.y+(c.rbb[3]-c.rbb[1])))+64;
  for (const d of directives){ L.push(`TEXT 0 ${ty} Left 2 !${d}`); ty+=32; }
  return L.join('\n')+'\n';
}

const SAFE_MODES = [
  {},
  {bridge:1},
  {noLPass:1},
  {noFar:1, noHang:1, noLPass:1},
  {noFar:1, noHang:1, noLPass:1, bridge:1},
  {noFb:1, noFar:1, noLeg:1, noHang:1, noLPass:1},
  {noFb:1, noFar:1, noLeg:1, noHang:1, noLPass:1, bridge:1},
  {noFb:1, noFar:1, noLeg:1, noHang:1, noLPass:1, spacingX:1.5},
  {noFb:1, noFar:1, noLeg:1, noHang:1, noLPass:1, spacingX:1.5, bridge:1},
  {noFb:1, noFar:1, noLeg:1, noHang:1, noLPass:1, spacingX:2.25, bridge:1},
];
module.exports = { convert, SYMBOLS, rot, parseNetlist, classifyNets, railLabel, SAFE_MODES };

if (require.main === module){
  const fs=require('fs');
  const [inF, outF] = process.argv.slice(2);
  convert(fs.readFileSync(inF,'utf8')).then(asc=>{
    fs.writeFileSync(outF, asc);
    console.log('wrote', outF);
  }).catch(e=>{ console.error(e); process.exit(1); });
}
