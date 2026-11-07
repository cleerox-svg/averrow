(function(root){
"use strict";
var MONO='"Geist Mono",ui-monospace,Menlo,monospace',SANS='Geist,ui-sans-serif,system-ui,sans-serif';
function rng(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function cl(x){return x<0?0:x>1?1:x}
function rp(u,a,b){return cl((u-a)/(b-a))}
function eio(x){x=cl(x);return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2}
function eo(x){x=cl(x);return 1-Math.pow(1-x,3)}
function eo4(x){x=cl(x);return 1-Math.pow(1-x,4)}
var ORDER=[3,11,0,9,1,10,2,12],NAMES={1:"acmepay-support.example",3:"acme-payroll-login.example",11:"acme-hr-portal.example"};
/* u is the story position: 0 empty, 1 domains found, 2 infrastructure linked, 3 operation attributed, 4 takedowns filed */
function build(w,h,cp){
 var sx=cp?w/760:1,sy=cp?h/620:1,mg=cp?20:30,d3=cp?[w*.42,h*.6]:[262,335],rnd=rng(11),nodes=[],by={},links=[],rank=0,i,p;
 function P(x,y){return[x*sx,y*sy]}
 function arc(c,r,d){var a=d*Math.PI/180;return P(c[0]+Math.cos(a)*r,c[1]+Math.sin(a)*r)}
 function sc(){var x,y;do{x=mg+rnd()*(w-(cp?mg+95:150)-mg);y=mg+rnd()*(h*(cp?.86:.8)-2*mg)}while(!cp&&y>d3[1]-22&&y<d3[1]+22&&x>d3[0]-200&&x<d3[0]+16);return[x,y]}
 function add(n,ap){var s=n.id==="d3"?d3:sc();n.sx=s[0];n.sy=s[1];n.ph=rnd()*6.28;n.ap=ap;nodes.push(n);by[n.id]=n}
 var A0=[345,180],A1=[345,448],hub=P(545,316),dr=cp?4.4:6.5,ar=cp?5.6:8;
 for(i=0;i<14;i++){p=i<9?arc(A0,138,120+i*18.75):arc(A1,112,90+(i-9)*37.5);
  add({id:"d"+i,kind:"dom",col:i<9?(i<5?"crit":"high"):(i<12?"crit":"high"),tx:p[0],ty:p[1],r:dr,label:NAMES[i]||null,side:"l"},i===3?.05:.4+(rank++)*.045)}
 p=P(A0[0],A0[1]);add({id:"a0",kind:"asn",col:"high",tx:p[0],ty:p[1],r:ar,label:"AS64500",sub:"203.0.113.0/24",side:"ur"},1.05);
 p=P(A1[0],A1[1]);add({id:"a1",kind:"asn",col:"high",tx:p[0],ty:p[1],r:ar,label:"AS64501",sub:"198.51.100.0/24",side:"lr"},1.12);
 p=P(392,316);add({id:"c0",kind:"cert",col:"med",tx:p[0],ty:p[1],r:ar,label:"TLS cert",sub:"one shared serial",side:cp?"d":"l"},1.2);
 p=P(640,150);add({id:"s0",kind:"soc",col:"low",tx:p[0],ty:p[1],r:ar,label:"@acme_hr_support",sub:"fake profile",side:"r"},2.45);
 p=P(640,440);add({id:"p0",kind:"app",col:"low",tx:p[0],ty:p[1],r:ar,label:"Acme Pay",sub:"cloned app",side:"r"},2.52);
 var k=0;
 for(i=0;i<14;i++){links.push({a:"d"+i,b:i<9?"a0":"a1",t0:1.3+k*.022,dur:.25,kind:"ev"});k++}
 [6,7,8,9,10].forEach(function(j){links.push({a:"d"+j,b:"c0",t0:1.3+k*.022,dur:.25,kind:"ev"});k++});
 links.push({a:"a0",b:"hub",t0:2.25,dur:.3,kind:"sp"},{a:"a1",b:"hub",t0:2.3,dur:.3,kind:"sp"},{a:"c0",b:"hub",t0:2.35,dur:.3,kind:"sp"},{a:"s0",b:"hub",t0:2.6,dur:.3,kind:"rel"},{a:"p0",b:"hub",t0:2.68,dur:.3,kind:"rel"});
 var st={};for(i=0;i<14;i++){var oi=ORDER.indexOf(i);st["d"+i]=oi>=0?{rm:3.3+oi*.07}:(i>=4&&i<=7)?"pending":"queued"}
 return{w:w,h:h,cp:cp,cx:hub[0],cy:hub[1],hubR:cp?40:68,nodes:nodes,by:by,links:links,st:st}
}
function pos(S,n,u,t){var c=eio(rp(u,1.1,1.95)),d=(1-c)*(S.cp?7:11),x=n.sx+Math.sin(t*.7+n.ph)*d,y=n.sy+Math.cos(t*.55+n.ph*1.3)*d;return[x+(n.tx-x)*c,y+(n.ty-y)*c]}
function lpos(n,x,y){var g=n.r+8;return n.side==="l"?{x:x-g,y:y+4,a:"end"}:n.side==="r"?{x:x+g,y:y-1,a:"start"}:n.side==="ur"?{x:x+g,y:y-9,a:"start"}:n.side==="d"?{x:x,y:y+g+10,a:"middle"}:{x:x+g-2,y:y+g,a:"start"}}
function nAl(n,u){var a=eo(rp(u,n.ap,n.ap+.25));return n.kind==="dom"&&n.id!=="d3"?a*(.42+.58*rp(u,1.35,1.9)):a}
function lAl(n,u){return n.kind==="dom"?(n.id==="d3"?rp(u,.15,.4):rp(u,1.7,2.05)):n.kind==="soc"||n.kind==="app"?rp(u,2.6,2.9):rp(u,n.ap+.2,n.ap+.45)}
function halo(c,C,s,x,y){c.lineWidth=3.5;c.lineJoin="round";c.strokeStyle=C.bg;c.strokeText(s,x,y);c.fillText(s,x,y)}
function draw(c,S,C,u,t,G){
 var cp=S.cp,P={},al={},hp=eo(rp(u,2,2.45)),R=S.hubR,cx=S.cx,cy=S.cy;
 c.clearRect(0,0,S.w,S.h);
 S.nodes.forEach(function(n){P[n.id]=pos(S,n,u,t);al[n.id]=nAl(n,u)});P.hub=[cx,cy];
 S.links.forEach(function(l){var p=eo(rp(u,l.t0,l.t0+l.dur));if(p<=0)return;
  var a=P[l.a],b=P[l.b],ex=a[0]+(b[0]-a[0])*p,ey=a[1]+(b[1]-a[1])*p;
  if(l.b==="hub"){var dx=b[0]-a[0],dy=b[1]-a[1],d=Math.hypot(dx,dy)||1;ex=a[0]+dx*p*(1-R/d);ey=a[1]+dy*p*(1-R/d)}
  c.globalAlpha=G*(l.kind==="ev"?.5:.6);c.strokeStyle=C.pt;c.lineWidth=l.kind==="ev"?1:1.2;
  c.setLineDash(l.kind==="rel"?[3,4]:[]);c.beginPath();c.moveTo(a[0],a[1]);c.lineTo(ex,ey);c.stroke();c.setLineDash([]);
  if(p<1){c.globalAlpha=G;c.fillStyle=C.text;c.beginPath();c.arc(ex,ey,2,0,6.3);c.fill()}});
 if(hp>0){c.globalAlpha=G;c.fillStyle="rgba(76,92,248,"+.1*hp+")";c.beginPath();c.arc(cx,cy,R,0,6.3);c.fill();
  var pg=rp(u,2.5,3.1);if(pg>0&&pg<1){c.globalAlpha=G*(1-pg)*.5;c.strokeStyle=C.pt;c.lineWidth=1;c.beginPath();c.arc(cx,cy,R+pg*26,0,6.3);c.stroke()}
  c.globalAlpha=G;c.strokeStyle=C.pt;c.lineWidth=1.6;c.beginPath();c.arc(cx,cy,R,-1.5708,-1.5708+6.2832*hp);c.stroke()}
 S.nodes.forEach(function(n){var a=al[n.id]*G;if(a<=0)return;var q=P[n.id],s=S.st[n.id],rm=s&&s.rm?cl((u-s.rm)/.08):0,col=C[n.col],r=n.r*(.85+.15*eo(rp(u,n.ap,n.ap+.25)));
  if(n.id==="d3"){var hl=rp(u,.1,.4)*(1-rp(u,1.9,2.3)),pg=rp(u,.15,.7);
   if(hl>0){c.globalAlpha=a*hl*.85;c.strokeStyle=C.pt;c.lineWidth=1.2;c.beginPath();c.arc(q[0],q[1],r+6,0,6.3);c.stroke();
    if(pg<1){c.globalAlpha=a*hl*(1-pg)*.5;c.beginPath();c.arc(q[0],q[1],r+6+pg*14,0,6.3);c.stroke()}}}
  c.globalAlpha=a;c.lineWidth=2;
  if(rm>0){c.strokeStyle=C.muted;c.fillStyle=C.bg;c.globalAlpha=a*(.35+.65*(1-rm))}else{c.strokeStyle=col;c.fillStyle=C.bg}
  c.beginPath();c.arc(q[0],q[1],r,0,6.3);c.fill();c.stroke();
  if(rm<=0){c.fillStyle=col;c.globalAlpha=a*.9;c.beginPath();c.arc(q[0],q[1],r*.38,0,6.3);c.fill()}
  if(s==="pending"){var pv=rp(u,3.35,3.5);if(pv>0){c.globalAlpha=a*pv;c.strokeStyle=C.high;c.lineWidth=1;c.setLineDash([2,3]);c.beginPath();c.arc(q[0],q[1],r+4,0,6.3);c.stroke();c.setLineDash([])}}});
 c.textBaseline="alphabetic";
 S.nodes.forEach(function(n){if(!n.label||(cp&&(n.kind==="dom"||n.kind==="soc"||n.kind==="app")))return;
  var a=al[n.id]*lAl(n,u)*G,s=S.st[n.id],rm=s&&s.rm?cl((u-s.rm)/.08):0;if(a<=0)return;
  var q=P[n.id],lp=lpos(n,q[0],q[1]);c.globalAlpha=a*.9*(1-.45*rm);c.textAlign=lp.a==="middle"?"center":lp.a;c.font="400 "+(cp?10:11)+"px "+MONO;
  c.fillStyle=C.t2;halo(c,C,n.label,lp.x,lp.y);if(n.sub&&!cp){c.fillStyle=C.muted;halo(c,C,n.sub,lp.x,lp.y+13)}});
 c.textAlign="center";var la=rp(u,2.4,2.65)*G;
 if(la>0){c.globalAlpha=la;c.fillStyle=C.pt;c.font="500 "+(cp?11:14)+"px "+MONO;c.fillText("OP-2291",cx,cy-(cp?1:2));
  c.fillStyle=C.muted;c.font="400 "+(cp?10:11)+"px "+MONO;c.fillText("19 findings",cx,cy+(cp?12:14))}
 la=rp(u,2.45,2.7)*G;if(la>0){c.globalAlpha=la;c.fillStyle=C.text;c.font="600 "+(cp?12:15)+"px "+SANS;halo(c,C,"Acme payroll sign-in impersonation",cx,cy-R-(cp?10:14))}
 la=rp(u,2.7,2.95)*G;if(la>0){c.globalAlpha=la*.9;c.fillStyle=C.t2;c.font="400 "+(cp?10:11)+"px "+MONO;halo(c,C,"Actor FX-114 · example",cx,cy+R+(cp?14:17))}
 c.globalAlpha=1}
function cardState(u){var rem=0;ORDER.forEach(function(_,o){if(u>=3.3+o*.07+.08)rem++});var pv=rp(u,3.2,3.4),o=rp(u,3,3.2);
 return{op:o,ty:8*(1-eo(o)),rem:rem,pen:Math.round(4*pv),que:Math.round(2*pv),bp:4/14*100*pv,br:rem/14*100}}
function colors(){var s=getComputedStyle(document.documentElement),g=function(n){return s.getPropertyValue("--"+n).trim()};
 return{crit:g("crit"),high:g("high"),med:g("med"),low:g("low"),bg:g("bg"),pt:g("primary-text"),text:g("text"),muted:g("muted"),t2:g("text-2")}}
function mount(stage){
 var cv=stage.querySelector("canvas"),tk=stage.querySelector(".tk"),c=cv.getContext("2d"),C=colors(),S,sc,dpr,last=[0,1,0],q=function(i){return document.getElementById(i)},
  nR=q("tk-rem"),nP=q("tk-pen"),nQ=q("tk-que"),bR=q("tk-b-rem"),bP=q("tk-b-pen");
 function size(){var r=cv.parentNode.getBoundingClientRect(),cp=r.width<620;dpr=Math.min(devicePixelRatio||1,2);cv.width=Math.round(r.width*dpr);cv.height=Math.round(r.height*dpr);
  var lw=cp?390:760;S=build(lw,cp?340:620,cp);sc=r.width/lw;render.apply(0,last)}
 function render(u,G,t){last=[u,G,t];c.setTransform(dpr*sc,0,0,dpr*sc,0,0);draw(c,S,C,u,t,G);
  var s=cardState(u);tk.style.opacity=s.op*G;tk.style.transform="translateY("+s.ty+"px)";nR.textContent=s.rem;nP.textContent=s.pen;nQ.textContent=s.que;bR.style.width=s.br+"%";bP.style.width=s.bp+"%"}
 size();addEventListener("resize",size);stage.classList.add("live");
 return{render:render}}
var SEG=[[2,.9],[2.6,1],[2.2,1],[3,2.8]],TOT=15.5,OUT=.45,GAP=.45,ST=[0,2.9,6.5,9.7];
function auto(g,ui,clock){
 var tau=0,u=0,G=1,mode="auto",tw=null,last=0,step=1,fill=0;
 function seg(){var k=3;while(k>0&&tau<ST[k])k--;return k}
 function tick(now){var dt=last?Math.min((now-last)/1e3,.1):0;last=now;
  if(tw){var k=cl((now-tw.t)/tw.d);u=tw.a+(tw.b-tw.a)*eo4(k);if(k>=1)tw=null}
  else if(mode==="auto"){tau+=dt;if(tau>=TOT+OUT+GAP){tau=0;last=now}
   var k0=seg(),L=SEG[k0][0];u=tau-ST[k0]<L?k0+(tau-ST[k0])/L:k0+1;if(tau>=TOT)u=4;
   G=1-rp(tau,TOT,TOT+OUT);step=k0+1;fill=cl((tau-ST[k0])/(L+SEG[k0][1]));if(tau>=TOT){fill=1}}
  else if(u>=1.95&&G===1&&!tw)return;
  g.render(u,G,now/1e3);ui(step,mode==="auto"?fill:1,mode)}
 return{tick:tick,
  jump:function(j){mode="paused";step=j;G=1;tw={a:u,b:j,t:clock(),d:480};tau=ST[j-1]+SEG[j-1][0]},
  toggle:function(){if(mode==="auto"){mode="paused"}else{mode="auto";G=1;tw=null;if(Math.abs(u-step)>.01)tw={a:u,b:step,t:clock(),d:240};tau=ST[step-1]+SEG[step-1][0]}ui(step,mode==="auto"?fill:1,mode)},
  reset:function(){tau=0;u=0;G=1;mode="auto";tw=null;last=0}}}
function loop(el,fn,minDt){var raf=0,run=false,vis=true,lt=0;
 function f(n){if(!run)return;raf=requestAnimationFrame(f);if(n-lt<minDt)return;lt=n;fn(n)}
 function go(){if(!run&&vis&&!document.hidden){run=true;raf=requestAnimationFrame(f)}}
 function stop(){run=false;cancelAnimationFrame(raf)}
 new IntersectionObserver(function(e){vis=e[0].isIntersecting;vis?go():stop()}).observe(el);
 document.addEventListener("visibilitychange",function(){document.hidden?stop():go()});go()}
root.HG={build:build,draw:draw,cardState:cardState,lpos:lpos,mount:mount,auto:auto,loop:loop,rp:rp,cl:cl,eio:eio,eo:eo,ORDER:ORDER,SEG:SEG,ST:ST};
})(window);
