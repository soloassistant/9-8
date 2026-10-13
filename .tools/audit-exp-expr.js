(()=>{
  const q=new URLSearchParams(location.search||'');
  const scale=q.get('scale');
  const mutate=q.get('mutate');
  if(scale){document.documentElement.style.setProperty('--ui-scale',scale);}
  if(mutate==='1'){
    const p=document.querySelector('.taro-tabbar__panel');
    if(p){p.style.setProperty('width','auto','important');}
  }
  void document.documentElement.offsetHeight;

  const rect=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return{w:+b.width.toFixed(2),x:+b.x.toFixed(2),h:+b.height.toFixed(2)}};
  const alt=s=>{const e=document.querySelector(s);if(!e)return null;return{offsetW:e.offsetWidth,clientW:e.clientWidth,cssW:getComputedStyle(e).width,offsetX:e.offsetLeft}};
  return JSON.stringify({
    vw:innerWidth, rem:getComputedStyle(document.documentElement).fontSize,
    uiScale:getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim(),
    hash:location.hash,
    panel:rect('.taro-tabbar__panel'), panelAlt:alt('.taro-tabbar__panel'),
    router:rect('.taro_router'),
    page:rect('.taro_page'), pageAlt:alt('.taro_page'),
    container:rect('.taro-tabbar__container'),
    tabbar:rect('.taro-tabbar__tabbar'),
    tabbarDisplay:(()=>{const e=document.querySelector('.taro-tabbar__tabbar');return e?getComputedStyle(e).display:null})(),
    scrollW:document.documentElement.scrollWidth,
    text:(document.body.innerText||'').replace(/\s+/g,' ').slice(0,60)
  });
})()
