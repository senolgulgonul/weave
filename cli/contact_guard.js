'use strict';
// Preserve the named connection graph while moving a routing vertex off an
// unrelated conductor. All incident wires on its OWN net move together.
// This is a local repair over the existing ELK layout, not a new layout engine.
const same=(a,b)=>a[0]===b[0]&&a[1]===b[1];
const p1=w=>w.slice(0,2), p2=w=>w.slice(2,4);
const net=w=>String(w[4]).toLowerCase();
const on=(p,w)=>w[0]===w[2]?p[0]===w[0]&&p[1]>=Math.min(w[1],w[3])&&p[1]<=Math.max(w[1],w[3]):
  w[1]===w[3]&&p[1]===w[1]&&p[0]>=Math.min(w[0],w[2])&&p[0]<=Math.max(w[0],w[2]);
const endpoint=(p,w)=>same(p,p1(w))||same(p,p2(w));
const overlap=(a,b)=>a[0]===a[2]&&b[0]===b[2]&&a[0]===b[0]?
  Math.max(Math.min(a[1],a[3]),Math.min(b[1],b[3]))<Math.min(Math.max(a[1],a[3]),Math.max(b[1],b[3])):
  a[1]===a[3]&&b[1]===b[3]&&a[1]===b[1]&&Math.max(Math.min(a[0],a[2]),Math.min(b[0],b[2]))<Math.min(Math.max(a[0],a[2]),Math.max(b[0],b[2]));
const touches=(a,b)=>overlap(a,b)||on(p1(a),b)||on(p2(a),b)||on(p1(b),a)||on(p2(b),a);
function repairContacts(wires,comps,flags,grid){
  const protectedPoints=[];
  for(const c of comps)if(c.abs)c.abs.forEach((p,i)=>protectedPoints.push({p,net:String(c.nets[i]).toLowerCase()}));
  for(const [x,y,,sourceNet] of flags)protectedPoints.push({p:[x,y],net:sourceNet.toLowerCase()});
  function moveVertex(p,own,foreign){
    if(protectedPoints.some(t=>same(t.p,p)))return false;
    const incident=[];
    for(let i=0;i<wires.length;i++)if(net(wires[i])===own&&endpoint(p,wires[i]))incident.push(i);
    if(!incident.length)return false;
    const foreignVertical=foreign[0]===foreign[2];
    for(const amount of [grid,-grid,2*grid,-2*grid,3*grid,-3*grid,4*grid,-4*grid]){
      const moved=foreignVertical?[p[0]+amount,p[1]]:[p[0],p[1]+amount];
      const generated=[];let valid=true;
      for(const idx of incident){
        const w=wires[idx],q=same(p,p1(w))?p2(w):p1(w),raw=w[4];
        const dx=q[0]-p[0],dy=q[1]-p[1];
        if((dy===0&&moved[1]===p[1])||(dx===0&&moved[0]===p[0])){
          // Extending/shortening a straight segment must retain any old
          // same-net junction or fixed pin along the removed portion.
          const candidate=[...moved,...q,raw];
          const oldPoints=protectedPoints.filter(t=>t.net===own&&on(t.p,w));
          for(const z of wires)if(net(z)===own)for(const t of [p1(z),p2(z)])if(on(t,w)&&!same(t,p))oldPoints.push({p:t});
          if(oldPoints.some(t=>!on(t.p,candidate))){valid=false;break;}
          generated.push(candidate);
        }else{
          // Move the complete perpendicular segment when it has no interior
          // same-net tap. A one-grid dogleg would merely re-enter a longer
          // collinear foreign bridge at its return point.
          const interior=t=>on(t,w)&&!same(t,p)&&!same(t,q);
          if(protectedPoints.some(t=>t.net===own&&interior(t.p))||
             wires.some((z,j)=>j!==idx&&net(z)===own&&(interior(p1(z))||interior(p2(z))))){valid=false;break;}
          const elbow=dy!==0?[moved[0],q[1]]:[q[0],moved[1]];
          generated.push([...moved,...elbow,raw],[...elbow,...q,raw]);
        }
      }
      if(!valid)continue;
      const segs=generated.filter(w=>!same(p1(w),p2(w)));
      for(const g of segs){
        for(let j=0;j<wires.length;j++)if(net(wires[j])!==own&&touches(g,wires[j])){valid=false;break;}
        if(!valid)break;
        if(protectedPoints.some(t=>t.net!==own&&on(t.p,g))){valid=false;break;}
      }
      if(!valid)continue;
      // An old own-net wire passing through the old vertex must not be
      // stranded. Such a vertex needs a more global routing change.
      if(wires.some((w,i)=>net(w)===own&&!incident.includes(i)&&on(p,w)) )continue;
      for(const i of incident.sort((a,b)=>b-a))wires.splice(i,1);
      wires.push(...segs);
      return true;
    }
    return false;
  }
  for(let round=0;round<128;round++){
    let fixed=false,found=false;
    outer:for(let i=0;i<wires.length;i++)for(let j=i+1;j<wires.length;j++){
      const a=wires[i],b=wires[j];if(net(a)===net(b)||!touches(a,b))continue;
      found=true;
      for(const p of [p1(a),p2(a)])if(on(p,b)&&moveVertex(p,net(a),b)){fixed=true;break outer;}
      for(const p of [p1(b),p2(b)])if(on(p,a)&&moveVertex(p,net(b),a)){fixed=true;break outer;}
    }
    if(!found||!fixed)break;
  }
}
module.exports={repairContacts};
