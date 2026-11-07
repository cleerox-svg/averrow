(function(){
var stage=document.getElementById("stage"),rail=document.getElementById("rail");
if(!stage||!rail||!document.documentElement.classList.contains("lv"))return;
var bt=[].slice.call(rail.querySelectorAll(".sb")),cap=rail.querySelector(".cap"),pp=rail.querySelector(".pp"),fl=bt.map(function(b){return b.firstChild}),cur=4,mode="auto",A,tm=0,fv=[],first=1;
function clock(){return window.__manual?window.__vnow:performance.now()}
function setCap(s,now){clearTimeout(tm);if(now){cap.textContent=s;return}cap.classList.add("sw");tm=setTimeout(function(){cap.textContent=s;cap.classList.remove("sw")},120)}
function ui(step,fill,m){
 if(step!==cur){cur=step;bt.forEach(function(b,i){i+1===step?b.setAttribute("aria-current","step"):b.removeAttribute("aria-current")});setCap(bt[step-1].dataset.cap,first);first=0}
 fl.forEach(function(e,i){var v=i+1<step?1:i+1===step?fill:0;v=Math.round(v*500)/500;if(fv[i]!==v){fv[i]=v;e.style.transform="scaleX("+v+")"}});
 if(m!==mode){mode=m;pp.setAttribute("aria-pressed",m==="paused");pp.setAttribute("aria-label",m==="paused"?"Play step animation":"Pause step animation")}}
function init(){
 var g=HG.mount(stage);A=HG.auto(g,ui,clock);
 bt.forEach(function(b){b.addEventListener("click",function(){A.jump(+b.dataset.i)})});
 pp.addEventListener("click",function(){A.toggle()});
 if(window.__manual){window.__step=function(n){window.__vnow=n;A.tick(n)};return}
 HG.loop(stage,A.tick,30)}
(window.requestIdleCallback||function(f){setTimeout(f,200)})(init,{timeout:1500});
})();
