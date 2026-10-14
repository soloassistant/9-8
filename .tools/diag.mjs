import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
const CHROME = 'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';
const BASE = 'https://48f86dcd48e3462dbe897b5fce534551.app.workbuddy.host/';
const OUT = '/d/Agent/.tmp-verify/diag'; fs.mkdirSync(OUT, { recursive: true });
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || '';
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE);
const port = 9500 + Math.floor(Math.random() * 200);
const child = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions',...(isLocal?['--no-proxy-server']:proxyUrl?[`--proxy-server=${proxyUrl}`]:[]),'--hide-scrollbars',`--remote-debugging-port=${port}`,`--user-data-dir=${path.join(OUT,'profile')}`,'--window-size=390,844','about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function endpoint(){ for(let i=0;i<60;i++){ try{ const r=await fetch(`http://127.0.0.1:${port}/json/version`); if(r.ok) return await r.json(); }catch{} await sleep(250);} throw new Error('no cdp'); }
class Cdp{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(this.pending.has(id)){this.pending.delete(id);reject(new Error('timeout '+method));}},45000);});}}
let cdp;
const ev = async e => { const r = await cdp.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}); return r.exceptionDetails?{__err:r.exceptionDetails.text}:r.result?.value; };
const click = async (x,y)=>{ await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y}); await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1}); await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1}); };
const findT = async (text,exact)=>{ const p=await ev(`(()=>{const t=${JSON.stringify(text)};const ex=${exact?'true':'false'};let best=null;for(const e of Array.from(document.querySelectorAll('body *'))){const txt=(e.textContent||'').trim();if(!txt)continue;const m=ex?txt===t:(txt.includes(t)&&txt.length<t.length+14);if(!m)continue;const r=e.getBoundingClientRect();if(r.width<6||r.height<6)continue;const a=r.width*r.height;if(!best||a<best.a)best={a,x:r.left+r.width/2,y:r.top+r.height/2,txt,y:r.top};}return best?{x:best.x,y:best.y,txt:best.txt,ty:best.y}:null;})()`); return p; };
const clickT = async (text,exact)=>{ const p=await findT(text,exact); if(!p||p.__err){console.log('  NOT FOUND',text);return false;} await click(p.x,p.y); console.log('  clicked',JSON.stringify(text),'->',JSON.stringify(p.txt)); return true; };
const dump = async (tag)=>{ const s=await ev(`JSON.stringify({inputs:Array.from(document.querySelectorAll('input')).map(i=>i.placeholder), topLeaves:Array.from(document.querySelectorAll('body *')).filter(e=>e.children.length===0&&(e.textContent||'').trim()&&e.getBoundingClientRect().top<220&&e.getBoundingClientRect().height>4).map(e=>({t:(e.textContent||'').trim(),y:Math.round(e.getBoundingClientRect().top)})).filter((v,i,a)=>a.findIndex(x=>x.t===v.t)===i).slice(0,16)})`); console.log(tag, s); return JSON.parse(s||'{}'); };
(async()=>{ try{
  await endpoint(); const t=await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`,{method:'PUT'})).json();
  const ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',()=>rej(new Error('ws')),{once:true});});
  cdp=new Cdp(ws); await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await cdp.send('Page.navigate',{url:BASE}); await sleep(7000);
  console.log('=== default (phone) ==='); await dump('D0');
  console.log('--- click 邮箱登录 ---'); await clickT('邮箱登录',false); await sleep(1200); await dump('D1-email');
  console.log('--- click 验证码登录 ---'); await clickT('验证码登录',false); await sleep(1200); await dump('D2-otp');
  try{child.kill('SIGKILL');}catch{} process.exit(0);
}catch(e){ console.log('FATAL',String(e.message||e)); try{child.kill('SIGKILL');}catch{} process.exit(1); }})();
