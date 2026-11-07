(function(){
var html=document.documentElement,wrap=document.getElementById("wrap");
if(!html.classList.contains("lv")||!wrap)return;
var pin=document.getElementById("pin"),stage=document.getElementById("stage"),cs=document.getElementById("cs"),track=wrap.querySelector(".track"),
 segs=[].slice.call(wrap.querySelectorAll(".seg b")),items=[].slice.call(wrap.querySelectorAll(".sl .st")),pp=wrap.querySelector(".pp"),
 mq=matchMedia("(min-width:900px)"),css=window.CSS&&CSS.supports&&CSS.supports("animation-timeline","view()"),
 K=[[0,4],[.05,4],[.17,1],[.29,1],[.4,2],[.5,2],[.62,3],[.7,3],[.84,4],[1,4]],SW=[.11,.29,.5,.7,1],
 g,A,step=0,lu=-1,lf=[],intro=true,t0=0,la=0,cur=0,mode="auto";
function clock(){return window.__manual?window.__vnow:performance.now()}
function mapU(p){for(var i=1;i<K.length;i++)if(p<=K[i][0]){var a=K[i-1],b=K[i];return a[1]+(b[1]-a[1])*HG.eio((p-a[0])/(b[0]-a[0]))}return 4}
function getP(){if(css){var v=parseFloat(getComputedStyle(wrap).getPropertyValue("--p"));if(v===v)return HG.cl(v)}var r=track.getBoundingClientRect();return HG.cl((72-r.top)/r.height)}
function ui(s,f,m){if(s!==cur){cur=s;items.forEach(function(e,i){i+1===s?e.setAttribute("aria-current","step"):e.removeAttribute("aria-current")})}
 if(m!==mode){mode=m;pp.setAttribute("aria-pressed",m==="paused");pp.setAttribute("aria-label",m==="paused"?"Play step animation":"Pause step animation")}}
function frame(now){
 if(!mq.matches){if(now-la<30)return;la=now;lu=-1;if(step){step=0;pin.dataset.step=0}A.tick(now);return}
 if(cur){cur=0;items.forEach(function(e){e.removeAttribute("aria-current")});A.reset()}
 var p=getP(),u,s;
 if(intro&&p<.02){if(!t0)t0=now;u=Math.min(4,(now-t0)/1600);if(u>=4)intro=false}else{intro=false;u=mapU(p)}
 s=p<SW[0]?0:p<SW[1]?1:p<SW[2]?2:p<SW[3]?3:4;
 if(s!==step){step=s;pin.dataset.step=s}
 segs.forEach(function(b,i){var v=Math.round(HG.rp(p,i?SW[i-1]:SW[0]-.001,SW[i])*500)/500;if(lf[i]!==v){lf[i]=v;b.style.transform="scaleX("+v+")"}});
 if(u!==lu||u<1.95){lu=u;g.render(u,1,now/1e3)}}
function init(){
 g=HG.mount(stage);A=HG.auto(g,ui,clock);
 pp.addEventListener("click",function(){A.toggle()});
 if(window.__manual){window.__step=function(n){window.__vnow=n;frame(n)};return}
 HG.loop(stage,frame,0)}
(window.requestIdleCallback||function(f){setTimeout(f,200)})(init,{timeout:1500});
})();
