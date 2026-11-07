const fs=require('fs');global.window=global;require('./core.js');const H=global.HG;
const {nav,copy}=require('../src/parts.js');const base=fs.readFileSync('../src/base.css','utf8');
const col={crit:'var(--crit)',high:'var(--high)',med:'var(--med)',low:'var(--low)'};const f=v=>v.toFixed(1);
function svg(w,h,cp){const S=H.build(w,h,cp),P={};S.nodes.forEach(n=>P[n.id]=[n.tx,n.ty]);P.hub=[S.cx,S.cy];let o='';
 S.links.forEach(l=>{const a=P[l.a],b=P[l.b];let bx=b[0],by=b[1];if(l.b==='hub'){const dx=b[0]-a[0],dy=b[1]-a[1],d=Math.hypot(dx,dy);bx=a[0]+dx*(1-S.hubR/d);by=a[1]+dy*(1-S.hubR/d)}
  o+=`<path d="M${f(a[0])} ${f(a[1])}L${f(bx)} ${f(by)}" stroke="var(--primary-text)" stroke-opacity="${l.kind==='ev'?.5:.6}" stroke-width="${l.kind==='ev'?1:1.2}"${l.kind==='rel'?' stroke-dasharray="3 4"':''} fill="none"/>`});
 o+=`<circle cx="${f(S.cx)}" cy="${f(S.cy)}" r="${f(S.hubR)}" fill="rgba(76,92,248,.1)" stroke="var(--primary-text)" stroke-width="1.6"/>`;
 S.nodes.forEach(n=>{const s=S.st[n.id],rm=s&&s.rm,x=f(n.tx),y=f(n.ty);
  if(rm)o+=`<circle cx="${x}" cy="${y}" r="${n.r}" fill="var(--bg)" stroke="var(--muted)" stroke-width="2" opacity=".35"/>`;
  else{o+=`<circle cx="${x}" cy="${y}" r="${n.r}" fill="var(--bg)" stroke="${col[n.col]}" stroke-width="2"/><circle cx="${x}" cy="${y}" r="${f(n.r*.38)}" fill="${col[n.col]}"/>`;
   if(s==='pending')o+=`<circle cx="${x}" cy="${y}" r="${n.r+4}" fill="none" stroke="var(--high)" stroke-dasharray="2 3"/>`}});
 S.nodes.forEach(n=>{if(!n.label||(cp&&(n.kind==='dom'||n.kind==='soc'||n.kind==='app')))return;const lp=H.lpos(n,n.tx,n.ty),rm=S.st[n.id]&&S.st[n.id].rm;
  o+=`<text x="${f(lp.x)}" y="${f(lp.y)}" text-anchor="${lp.a}"${rm?' opacity=".6"':''}>${n.label}</text>`;if(n.sub&&!cp)o+=`<text class="sub" x="${f(lp.x)}" y="${f(lp.y+13)}" text-anchor="${lp.a}">${n.sub}</text>`});
 const m=cp?'style="font-size:11px"':'';
 o+=`<text class="hubt" x="${f(S.cx)}" y="${f(S.cy-(cp?1:2))}" text-anchor="middle"${cp?' style="font-size:11px"':''}>OP-2291</text><text class="sub" x="${f(S.cx)}" y="${f(S.cy+(cp?12:14))}" text-anchor="middle">19 findings</text>`;
 o+=`<text class="ttl" x="${f(S.cx)}" y="${f(S.cy-S.hubR-(cp?10:14))}" text-anchor="middle"${cp?' style="font-size:12px"':''}>Acme payroll sign-in impersonation</text><text x="${f(S.cx)}" y="${f(S.cy+S.hubR+(cp?14:17))}" text-anchor="middle" opacity=".9">Actor FX-114 · example</text>`;
 return o}
const steps=[['Domain found','acme-payroll-login.example is spotted in new-registration data and matched to Acme.','Found','acme-payroll-login.example spotted in new-registration data and matched to Acme.'],
['Infrastructure linked','Shared hosting and a shared TLS certificate tie it to 13 more lookalike domains.','Linked','Shared hosting and one TLS certificate tie it to 13 more lookalike domains.'],
['Actor attributed','The cluster resolves into one operation and an actor group (fictional example). Related findings, shown dashed, are reviewed alongside.','Attributed','Grouped into one operation and an actor group. Dashed links are related findings.'],
['Takedown filed','Takedowns go out for each domain under your authorization. Status updates as hosts act.','Takedown','Takedowns filed for each domain under your authorization; status updates as hosts act.']];
const sl=`<ol class="sl">${steps.map((s,i)=>`<li><b>${s[0]}</b><span>${s[1]}</span></li>`).join('')}</ol>`;
const railBtns=steps.map((s,i)=>`<li><button type="button" class="sb" data-i="${i+1}" data-cap="${s[3]}"${i===3?' aria-current="step"':''} aria-label="Step ${i+1} of 4: ${s[0]}"><i class="fl"></i><span class="lg">${s[0]}</span><span class="sh">${s[2]}</span></button></li>`).join('');
const card=`<div class="tk" id="tk"><div class="tk-h"><span>Takedowns</span><span class="pill pri">Active</span></div><div class="tk-t"><i id="tk-b-rem" style="width:57.1%;background:var(--ok)"></i><i id="tk-b-pen" style="width:28.6%;background:var(--primary)"></i></div><div class="tk-n mono"><span><b id="tk-rem">8</b> removed</span><span><b id="tk-pen">4</b> pending</span><span><b id="tk-que">2</b> queued</span></div></div>`;
const figcap=`<figcaption id="cap" class="sr-only">Illustrative operation graph, in four steps: a lookalike domain is found, 13 more are linked through 2 hosting networks and 1 shared TLS certificate, the cluster resolves into one operation, OP-2291, and takedowns are filed (8 of 14 complete). A fake social profile and a cloned app are shown as related findings. Names changed.</figcaption>`;
const posters=`<svg class="poster poster-d" viewBox="0 0 760 620" aria-hidden="true" preserveAspectRatio="xMidYMid meet">${svg(760,620,false)}</svg><svg class="poster poster-m" viewBox="0 0 390 340" aria-hidden="true" preserveAspectRatio="xMidYMid meet">${svg(390,340,true)}</svg>`;
const core=fs.readFileSync('core.js','utf8').replace(/^\(function\(root\)\{\n"use strict";/,'(function(root){"use strict";');
function emit(n){let h=fs.readFileSync(n+'.tpl.html','utf8');
 const R={'/*BASE*/':base,'<!--NAV-->':nav,'<!--COPY-->':copy,'<!--POSTERS-->':posters,'<!--CARD-->':card,'<!--FIGCAP-->':figcap,'<!--SL-->':sl,'<!--RAILBTNS-->':railBtns,'/*CORE*/':core,'/*RUN*/':fs.readFileSync(n+'-run.js','utf8'),
  '<!--STEPSB-->':steps.map((s,i)=>`<li class="st" data-i="${i+1}"><h3 class="s-h">${s[0]}</h3><p class="s-p">${s[1]}</p></li>`).join('')};
 for(const k in R)h=h.split(k).join(R[k]);fs.writeFileSync('../'+n+'.html',h);console.log(n,h.length)}
process.argv.slice(2).forEach(emit);
