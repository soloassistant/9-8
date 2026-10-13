(()=>{
  const q=new URLSearchParams(location.search||'');
  const s=q.get('scale');
  if(s)document.documentElement.style.setProperty('--ui-scale',s);
  void document.documentElement.offsetHeight;
  const r=x=>{const e=document.querySelector(x);if(!e)return null;const b=e.getBoundingClientRect();return[Math.round(b.width),Math.round(b.x)]};
  const t=document.querySelector('.taro-tabbar__tabbar');
  return JSON.stringify({
    vw:innerWidth,
    scale:getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim(),
    panel:r('.taro-tabbar__panel'), page:r('.taro_page'),
    tabbar:t?r('.taro-tabbar__tabbar'):'absent',
    scrollW:document.documentElement.scrollWidth
  });
})()
