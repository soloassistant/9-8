(()=>{
  const g=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();const cs=getComputedStyle(e);return{w:+b.width.toFixed(2),x:+b.x.toFixed(2),y:+b.y.toFixed(2),h:+b.height.toFixed(2),display:cs.display,position:cs.position,visibility:cs.visibility}};
  const tb=document.querySelector('.taro-tabbar__tabbar');
  return JSON.stringify({
    vw:innerWidth, vh:innerHeight, dpr:devicePixelRatio,
    rem:getComputedStyle(document.documentElement).fontSize,
    stubKept:!!(window.WorkBuddyCloud&&window.WorkBuddyCloud.__probe),
    hash:location.hash,
    container:g('.taro-tabbar__container'),
    panel:g('.taro-tabbar__panel'),
    router:g('.taro_router'),
    page:g('.taro_page'),
    pageShow:g('.taro_page_show'),
    pageCount:document.querySelectorAll('.taro_page').length,
    tabbar:g('.taro-tabbar__tabbar'),
    tabbarExists:!!tb,
    scrollW:document.documentElement.scrollWidth,
    docW:document.documentElement.getBoundingClientRect().width,
    bodyW:document.body.getBoundingClientRect().width,
    text:(document.body.innerText||'').replace(/\s+/g,' ').slice(0,80)
  });
})()
