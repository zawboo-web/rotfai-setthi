'use strict';
// ===== ตุ๊กตุ๊กเศรษฐีไทย · เวอร์ชันเว็บแยก (GitHub Pages) =====
// แทนที่ระบบออนไลน์ของ Claude ด้วย PeerJS: เจ้าของห้องถือสถานะเกม เพื่อนต่อเข้ามาด้วยรหัสห้อง ไม่ต้องมีบัญชี
// v2: มีระบบกันหลุด (ping ทุก 4 วิ, ต่อใหม่อัตโนมัติ, เก็บข้อความที่ส่งไม่ทันไว้ส่งซ้ำ, กลับเข้าห้องเองเมื่อรีเฟรช)

const P2P={peer:null,conns:[],host:false,code:null,doc:null,listeners:[],hostConn:null,retry:null,closing:false,
           inRoom:false,lastHostSeen:0,pending:[],timer:null,restarting:false};
const PREFIX="rotfai-setthi-";
const PEER_OPTS={config:{iceServers:[{urls:"stun:stun.l.google.com:19302"},{urls:"stun:stun1.l.google.com:19302"},{urls:"stun:global.stun.twilio.com:3478"}]},pingInterval:4000};
function myPid(){ let id=null; try{id=localStorage.getItem("rotfai-pid");}catch(e){} if(!id){ id="p_"+Math.random().toString(36).slice(2,12); try{localStorage.setItem("rotfai-pid",id);}catch(e){} } return id; }
function snapOf(doc){ return {exists:!!doc, data:()=>doc?JSON.parse(JSON.stringify(doc)):undefined}; }
function notifyLocal(){ const s=snapOf(P2P.doc); P2P.listeners.forEach(fn=>{ try{fn(s);}catch(e){console.error(e);} }); }
function hostSave(){ try{ if(P2P.doc) localStorage.setItem("rotfai-host-"+P2P.code,JSON.stringify(P2P.doc)); else localStorage.removeItem("rotfai-host-"+P2P.code);}catch(e){} }
function broadcast(){ const m={t:"doc",doc:P2P.doc}; P2P.conns.forEach(c=>{ try{ if(c.open) c.send(m);}catch(e){} }); }
function hostApply(fn){ fn(); hostSave(); broadcast(); setTimeout(notifyLocal,0); }

// ---------- สถานะการเชื่อมต่อบนแถบด้านบน ----------
let lastNetToast=0;
function setNet(text,level){
  let el=document.getElementById("netChip");
  if(!P2P.inRoom){ if(el) el.remove(); return; }
  if(!el){ el=document.createElement("span"); el.id="netChip"; el.className="chip"; el.setAttribute("aria-live","polite"); const m=document.getElementById("menuBtn"); m.parentNode.insertBefore(el,m); }
  const col=level==="bad"?"var(--minus)":level==="warn"?"var(--accent)":"#2E9A4E";
  el.innerHTML=`<span style="width:9px;height:9px;border-radius:50%;background:${col};display:inline-block;flex:none"></span><span class="t">${text}</span>`; el.title=text;
}
function warnOnce(msg){ const now=Date.now(); if(now-lastNetToast>8000){ lastNetToast=now; toast(msg); } }

function makeRef(){
  return {
    async set(body){ if(P2P.host) hostApply(()=>{P2P.doc=JSON.parse(JSON.stringify(body));}); else sendHost({t:"set",body}); },
    async update(p){ if(P2P.host) hostApply(()=>{P2P.doc={...(P2P.doc||{}),...JSON.parse(JSON.stringify(p))};}); else sendHost({t:"update",p}); },
    async delete(){ if(P2P.host) hostApply(()=>{P2P.doc=null;}); else sendHost({t:"leave",uid:ON.me}); },
    async get(){ return snapOf(P2P.doc); },
    async acquire(){ return {acquired:true}; },
    onSnapshot(fn){ P2P.listeners.push(fn); if(P2P.doc) setTimeout(()=>fn(snapOf(P2P.doc)),0); return ()=>{ P2P.listeners=P2P.listeners.filter(f=>f!==fn); }; }
  };
}
function sendHost(m){
  const c=P2P.hostConn;
  if(c&&c.open){ try{ c.send(m); return; }catch(e){} }
  // ส่งไม่ได้: เก็บไว้ส่งตอนต่อกลับ (set เก็บแค่อันล่าสุดเพราะเป็นสถานะทั้งเกม)
  if(m.t==="set") P2P.pending=P2P.pending.filter(x=>x.t!=="set");
  P2P.pending.push(m);
  guestReconnect(T("ส่งข้อมูลไม่ทัน กำลังต่อใหม่…"));
}

// ---------- เจ้าของห้อง ----------
function hostHandle(conn,m){
  if(!m||typeof m!=="object") return;
  conn._seen=Date.now();
  if(m.t==="ping"){ try{conn.send({t:"pong"});}catch(e){} return; }
  if(m.t==="pong") return;
  if(m.t==="join"){
    conn._uid=m.uid;
    const d=P2P.doc; if(!d) return;
    if(!(d.seats||[]).some(s=>s.uid===m.uid)){
      if(d.status!=="lobby"){ conn.send({t:"err",msg:"ห้องนี้เริ่มเล่นไปแล้ว"}); return; }
      if(d.seats.length>=4){ conn.send({t:"err",msg:"ห้องเต็มแล้ว"}); return; }
      hostApply(()=>{ d.seats=[...d.seats,{uid:m.uid,co:defaultCo(d.seats.length)}]; });
    } else conn.send({t:"doc",doc:P2P.doc});
    hostStatus();
  } else if(m.t==="set"&&m.body){
    const cur=P2P.doc;
    if(!cur||cur.status==="lobby"||(m.body.rev||0)>=(cur.rev||0)) hostApply(()=>{P2P.doc=m.body;});
    else conn.send({t:"doc",doc:P2P.doc});   // ข้อมูลเก่ากว่า: ส่งของล่าสุดกลับไปแทน
  }
  else if(m.t==="update"&&m.p){ hostApply(()=>{P2P.doc={...P2P.doc,...m.p};}); }
  else if(m.t==="leave"){ if(P2P.doc&&P2P.doc.status==="lobby") hostApply(()=>{P2P.doc.seats=P2P.doc.seats.filter(s=>s.uid!==m.uid);}); }
}
function hostStatus(){
  const live=new Set(P2P.conns.filter(c=>c.open&&c._uid).map(c=>c._uid));
  const seats=(P2P.doc&&P2P.doc.seats||[]).filter(s=>!s.bot&&s.uid!==ON.me);
  const on=seats.filter(s=>live.has(s.uid)).length;
  if(P2P.peer&&P2P.peer.disconnected) setNet(T("กำลังต่อเซิร์ฟเวอร์…"),"warn");
  else setNet(seats.length?T("เพื่อนออนไลน์ {a}/{b}",{a:on,b:seats.length}):T("เปิดห้องอยู่"), on<seats.length?"warn":"ok");
}
function wireHostPeer(peer,res){
  peer.on("open",()=>{ hostSave(); P2P.restarting=false; hostStatus(); res&&res(true); res=null; });
  peer.on("connection",conn=>{
    conn._seen=Date.now();
    P2P.conns.push(conn);
    conn.on("open",()=>{ conn.send({t:"doc",doc:P2P.doc}); });
    conn.on("data",m=>hostHandle(conn,m));
    conn.on("close",()=>{ P2P.conns=P2P.conns.filter(c=>c!==conn); hostStatus(); });
    conn.on("error",()=>{});
  });
  peer.on("error",e=>{
    if(e.type==="unavailable-id"){ if(res){res("taken");res=null;} else setTimeout(restartHost,3000); }
    else if(["network","server-error","socket-error","socket-closed"].includes(e.type)){ if(res){res(false);res=null;} else { hostStatus(); setTimeout(()=>{ if(P2P.peer===peer&&peer.disconnected&&!peer.destroyed){ try{peer.reconnect();}catch(x){} } },2500); } }
  });
  peer.on("disconnected",()=>{ if(P2P.closing||P2P.peer!==peer) return; hostStatus(); setTimeout(()=>{ if(P2P.peer===peer&&peer.disconnected&&!peer.destroyed){ try{peer.reconnect();}catch(x){} } },1500); });
  peer.on("close",()=>{ if(P2P.closing||P2P.peer!==peer) return; restartHost(); });
}
function startHost(code,doc){
  return new Promise(res=>{
    closePeer(); P2P.host=true; P2P.code=code; P2P.doc=doc;
    const peer=new Peer(PREFIX+code,PEER_OPTS); P2P.peer=peer;
    wireHostPeer(peer,res);
  });
}
// เปิด peer ใหม่ด้วยรหัสห้องเดิม โดยไม่ล้างสถานะเกมและผู้ฟัง
function restartHost(){
  if(!P2P.inRoom||!P2P.host||P2P.restarting&&P2P.peer&&!P2P.peer.destroyed) return;
  P2P.restarting=true; setNet(T("กำลังเปิดห้องใหม่…"),"warn");
  try{ P2P.peer&&P2P.peer.destroy(); }catch(e){}
  P2P.conns=[];
  const peer=new Peer(PREFIX+P2P.code,PEER_OPTS); P2P.peer=peer;
  wireHostPeer(peer,null);
}

// ---------- เพื่อนที่เข้าห้อง ----------
function guestConnect(){
  const peer=P2P.peer; if(!peer||peer.destroyed||peer.disconnected) return;
  if(P2P.hostConn&&P2P.hostConn.open) return;
  try{ P2P.hostConn&&P2P.hostConn.close(); }catch(e){}
  const conn=peer.connect(PREFIX+P2P.code,{reliable:true}); P2P.hostConn=conn;
  conn.on("open",()=>{
    P2P.lastHostSeen=Date.now();
    conn.send({t:"join",uid:ON.me});
    const q=P2P.pending; P2P.pending=[]; q.forEach(m=>{ try{conn.send(m);}catch(e){P2P.pending.push(m);} });
    setNet(T("เชื่อมต่อแล้ว"),"ok");
  });
  conn.on("data",m=>{
    P2P.lastHostSeen=Date.now();
    if(!m) return;
    if(m.t==="ping"){ try{conn.send({t:"pong"});}catch(e){} return; }
    if(m.t==="doc"){ P2P.doc=m.doc; if(P2P._firstDoc){ if(!m.doc) return; const f=P2P._firstDoc; P2P._firstDoc=null; f(true); return; } notifyLocal(); }
    else if(m.t==="err"){ toast(T(m.msg)); if(P2P._firstDoc){ const f=P2P._firstDoc; P2P._firstDoc=null; f(false); } }
  });
  conn.on("close",()=>{ if(P2P.hostConn===conn) guestReconnect(T("หลุดจากเจ้าของห้อง กำลังต่อใหม่…")); });
  conn.on("error",()=>{ if(P2P.hostConn===conn) guestReconnect(); });
}
function newGuestPeer(){
  const peer=new Peer(PEER_OPTS); P2P.peer=peer;
  peer.on("open",guestConnect);
  peer.on("disconnected",()=>{ if(P2P.closing||P2P.peer!==peer) return; setTimeout(()=>{ if(P2P.peer===peer&&peer.disconnected&&!peer.destroyed){ try{peer.reconnect();}catch(x){} } },1500); });
  peer.on("close",()=>{ if(P2P.closing||P2P.peer!==peer) return; guestReconnect(); });
  peer.on("error",e=>{
    if(e.type==="peer-unavailable"){ if(P2P._firstDoc&&!P2P.inRoom){ const f=P2P._firstDoc; P2P._firstDoc=null; f(false); } else guestReconnect(T("ยังติดต่อเจ้าของห้องไม่ได้ กำลังลองใหม่…")); }
    else if(["network","server-error","socket-error","socket-closed"].includes(e.type)){ if(P2P._firstDoc&&!P2P.inRoom){ const f=P2P._firstDoc; P2P._firstDoc=null; f(false); } else guestReconnect(); }
  });
  return peer;
}
function guestReconnect(msg){
  if(!P2P.inRoom||P2P.host||P2P.closing) return;
  setNet(T("หลุด กำลังต่อใหม่…"),"bad");
  if(msg) warnOnce(msg);
  clearTimeout(P2P.retry);
  P2P.retry=setTimeout(()=>{
    const peer=P2P.peer;
    if(!peer||peer.destroyed){ newGuestPeer(); return; }
    if(peer.disconnected){ try{peer.reconnect();}catch(e){ newGuestPeer(); } P2P.retry=setTimeout(()=>{ if(!(P2P.hostConn&&P2P.hostConn.open)) guestReconnect(); },5000); return; }
    guestConnect();
    P2P.retry=setTimeout(()=>{ if(!(P2P.hostConn&&P2P.hostConn.open)) guestReconnect(); },6000);
  },1500);
}
function startGuest(code){
  return new Promise(res=>{
    closePeer(); P2P.host=false; P2P.code=code;
    const t=setTimeout(()=>{ if(P2P._firstDoc){ P2P._firstDoc=null; res(false); } },10000);
    P2P._firstDoc=ok=>{ clearTimeout(t); res(ok); };
    newGuestPeer();
  });
}

// ---------- ตัวเฝ้าการเชื่อมต่อ ----------
function heartbeat(){
  if(!P2P.inRoom) return;
  const now=Date.now();
  if(P2P.host){
    P2P.conns.forEach(c=>{ if(c.open){ try{c.send({t:"ping"});}catch(e){} } if(now-(c._seen||now)>20000){ try{c.close();}catch(e){} } });
    P2P.conns=P2P.conns.filter(c=>now-(c._seen||now)<=20000);
    if(P2P.peer&&P2P.peer.destroyed) restartHost();
    hostStatus();
  } else {
    const c=P2P.hostConn;
    if(c&&c.open){ try{c.send({t:"ping"});}catch(e){} }
    if(!c||!c.open||now-P2P.lastHostSeen>12000){ try{c&&c.close();}catch(e){} guestReconnect(); }
  }
}
function checkNow(){ if(!P2P.inRoom) return; if(P2P.host){ const p=P2P.peer; if(!p||p.destroyed) restartHost(); else if(p.disconnected){ try{p.reconnect();}catch(e){ restartHost(); } } } else heartbeat(); }
document.addEventListener("visibilitychange",()=>{ if(!document.hidden) setTimeout(checkNow,300); });
addEventListener("online",()=>setTimeout(checkNow,500));
addEventListener("pageshow",()=>setTimeout(checkNow,300));

function closePeer(){
  P2P.closing=true; clearTimeout(P2P.retry); clearInterval(P2P.timer); P2P.timer=null;
  try{P2P.peer&&P2P.peer.destroy();}catch(e){}
  P2P.peer=null; P2P.conns=[]; P2P.hostConn=null; P2P.listeners=[]; P2P.doc=null; P2P.host=false; P2P.pending=[]; P2P.inRoom=false; P2P._firstDoc=null;
  setNet(); setTimeout(()=>{P2P.closing=false;},50);
}

// ---------- แทนที่ฟังก์ชันออนไลน์ของเวอร์ชัน Claude ----------
async function initOnline(){
  const ok=await loadPeerLib(); if(!ok) return false;
  ON.me=myPid();
  ON.user={profiles:async()=>({}),can:async()=>true,id:async()=>ON.me};
  ON.db={doc:()=>makeRef(),collection:()=>({where:()=>({limit:()=>({onSnapshot:()=>()=>{}})})})};
  return true;
}
function loadPeerLib(){
  if(window.Peer) return Promise.resolve(true);
  return new Promise(res=>{ const s=document.createElement("script"); s.src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"; s.onload=()=>res(true); s.onerror=()=>res(false); document.head.appendChild(s); });
}
const _enterRoom=enterRoom;
enterRoom=function(code){
  P2P.inRoom=true;
  try{ localStorage.setItem("rotfai-room",code); localStorage.setItem("rotfai-room-ts",String(Date.now())); }catch(e){}
  clearInterval(P2P.timer); P2P.timer=setInterval(heartbeat,4000);
  if(P2P.host) hostStatus(); else setNet(T("เชื่อมต่อแล้ว"),"ok");
  return _enterRoom(code);
};
function leaveOnline(){
  if(ON.unsub){ON.unsub();ON.unsub=null;}
  closePeer();
  try{ localStorage.removeItem("rotfai-room-ts"); }catch(e){}
  ON.ref=null; ON.meta=null; ON.handledTurn=null; ON.seenMove=null; ON.seenReport=null; ON.shownOver=false; ON.seenLog=0;
  MODE="local";
}
async function roomList(){
  while(true){
    const html=`<div class="stack"><button class="mode-btn primary" data-val="create"><b>${T("สร้างห้องใหม่")}</b><span>${T("ได้รหัส 4 ตัว ส่งให้เพื่อนพร้อมลิงก์เกม")}</span></button></div>
      <div class="field"><div class="label">${T("หรือใส่รหัสห้องของเพื่อน")}</div>
      <div style="display:flex;gap:8px;margin-top:6px"><input id="roomCode" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="${T("เช่น")} P8CS" style="flex:1;min-width:0;min-height:48px;border-radius:12px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink);padding:0 14px;font:600 20px var(--font-d);letter-spacing:.2em;text-transform:uppercase" aria-label="${T("รหัสห้อง")}"><button class="btn primary" style="flex:none" data-val="join">${T("เข้าห้อง")}</button></div></div>
      <p class="note">${T("@joinhint")}</p>`;
    const p=modal({eyebrow:T("เล่นออนไลน์"),title:T("เข้าห้องเล่น"),html,buttons:[{label:T("กลับ"),value:"back"}]});
    const inp=$("roomCode"); if(inp){ setTimeout(()=>inp.focus(),50); inp.onkeydown=e=>{ if(e.key==="Enter"){ e.preventDefault(); $("modal").querySelector('[data-val="join"]').click(); } }; }
    const v=await p;
    const code=($("roomCode")?.value||"").trim().toUpperCase();
    if(v==="back"||v===undefined) return home();
    if(v==="create") return createRoom();
    if(v==="join"){ if(!/^[A-Z0-9]{4}$/.test(code)){ toast(T("รหัสห้องต้องมี 4 ตัว")); continue; } return joinRoom(code); }
  }
}
async function createRoom(){
  modal({title:T("กำลังสร้างห้อง…"),html:"",buttons:[]});
  for(let tries=0;tries<4;tries++){
    const code=genCode();
    const doc={code,status:"lobby",host:ON.me,created:Date.now(),years:1,quiz:true,qTime:5,seats:[{uid:ON.me,co:defaultCo(0)}],rev:0};
    const r=await startHost(code,doc);
    if(r===true){ enterRoom(code); return; }
    if(r===false) break;
  }
  await info(T("สร้างห้องไม่ได้"),T("เชื่อมต่อเซิร์ฟเวอร์จับคู่ไม่ได้ ลองใหม่อีกครั้ง หรือเปลี่ยนเครือข่าย"));
  return roomList();
}
async function joinRoom(code){
  code=String(code).toUpperCase();
  modal({title:T("กำลังเข้าห้อง {c}…",{c:esc(code)}),html:"",buttons:[]});
  let saved=null; try{ saved=JSON.parse(localStorage.getItem("rotfai-host-"+code)||"null"); }catch(e){}
  if(saved&&saved.host===ON.me){
    // เจ้าของห้องกลับมา: เซิร์ฟเวอร์อาจยังจองรหัสเดิมไว้สักพัก ลองซ้ำได้นานราว 1 นาที
    for(let i=0;i<20;i++){
      const r=await startHost(code,saved);
      if(r===true){ enterRoom(code); return; }
      if(r===false) break;
      modal({title:T("กำลังเปิดห้อง {c} อีกครั้ง…",{c:esc(code)}),html:`<p class="note">${T("รอเซิร์ฟเวอร์ปล่อยรหัสห้องเดิม")} (${i+1}/20)</p>`,buttons:[]});
      await sleep(3000);
    }
    await info(T("เปิดห้องเดิมไม่ได้"),T("ลองใหม่อีกครั้งในอีกสักครู่")); return roomList();
  }
  const ok=await startGuest(code);
  if(!ok){ await info(T("เข้าห้องไม่ได้"),T("ไม่เจอห้อง {c} หรือเจ้าของห้องปิดเกมไปแล้ว",{c:esc(code)})+`<p class="note">${T("ถ้าใช้เน็ตมือถือ ลองเปลี่ยนเป็น Wi-Fi ดูก่อน บางเครือข่ายเชื่อมเครื่องต่อเครื่องไม่ได้")}</p>`); try{localStorage.removeItem("rotfai-room");localStorage.removeItem("rotfai-room-ts");}catch(e){} return roomList(); }
  enterRoom(code);
}
// ภาพการ์ด: อ่านจากโฟลเดอร์ cards/ ใน repo (เช่น cards/P01.webp)
function gcArt(id){ return `<img src="cards/${id}.webp" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;gc-ph&quot;>${T("ภาพ")} ${id}</span>'">`; }
async function initArt(){}
async function manageArt(){
  await info(T("ภาพการ์ด"),`<p>${T("เวอร์ชันนี้อ่านภาพจากโฟลเดอร์ <b>cards</b> ใน GitHub repo ของเกม")}</p>`);
}

// รีเฟรชหรือเปิดเกมใหม่ระหว่างเล่น (ภายใน 6 ชั่วโมง): กลับเข้าห้องเดิมให้อัตโนมัติ
(async function autoRejoin(){
  let code=null, ts=0;
  try{ code=localStorage.getItem("rotfai-room"); ts=+localStorage.getItem("rotfai-room-ts")||0; }catch(e){}
  if(!code||Date.now()-ts>6*3600*1000) return;
  const _home=home; home=async()=>{};
  closeModal(); await sleep(0); home=_home;
  onlineLobby(code);
})();

// ข้อความแปลเฉพาะเวอร์ชันนี้
TH_AT["@lobbyhint"]="บอกรหัสนี้ให้เพื่อน แล้วให้เพื่อนเปิดลิงก์เดียวกัน กด \"เล่นออนไลน์กับเพื่อน\" แล้วพิมพ์รหัสห้อง";
TH_AT["@joinhint"]="เพื่อนเปิดลิงก์เดียวกัน กด \"เล่นออนไลน์กับเพื่อน\" แล้วใส่รหัสห้อง ไม่ต้องสมัครอะไร";
Object.assign(TR,{
"@lobbyhint":["Share this code. Friends open the same link, tap \"Play online with friends\" and type the code","このコードを友だちに伝えよう。同じリンクを開いて「友だちとオンライン」からコードを入力します"],
"@joinhint":["Friends open the same link, tap \"Play online with friends\" and enter the code. No sign-up needed","友だちは同じリンクを開いて「友だちとオンライン」からコードを入力。登録は不要です"],
"ส่งข้อมูลไม่ทัน กำลังต่อใหม่…":["Couldn't send — reconnecting…","送信できませんでした。再接続中…"],
"กำลังต่อเซิร์ฟเวอร์…":["Connecting to server…","サーバーに接続中…"],
"เพื่อนออนไลน์ {a}/{b}":["Friends online {a}/{b}","オンライン {a}/{b}"],
"เปิดห้องอยู่":["Room open","ルーム開設中"],
"กำลังเปิดห้องใหม่…":["Reopening room…","ルームを開き直し中…"],
"เชื่อมต่อแล้ว":["Connected","接続中"],
"หลุดจากเจ้าของห้อง กำลังต่อใหม่…":["Lost the host — reconnecting…","ホストとの接続が切れました。再接続中…"],
"ยังติดต่อเจ้าของห้องไม่ได้ กำลังลองใหม่…":["Can't reach the host yet — retrying…","ホストにつながりません。再試行中…"],
"หลุด กำลังต่อใหม่…":["Disconnected — reconnecting…","切断。再接続中…"],
"ได้รหัส 4 ตัว ส่งให้เพื่อนพร้อมลิงก์เกม":["Get a 4-letter code to send with the game link","4文字のコードをゲームのリンクと一緒に送ろう"],
"หรือใส่รหัสห้องของเพื่อน":["Or enter a friend's room code","または友だちのルームコードを入力"],
"เช่น":["e.g.","例:"],
"รหัสห้อง":["Room code","ルームコード"],
"เข้าห้อง":["Join","入室"],
"เข้าห้องเล่น":["Join a room","ルームに入る"],
"รหัสห้องต้องมี 4 ตัว":["Room codes have 4 characters","ルームコードは4文字です"],
"กำลังสร้างห้อง…":["Creating room…","ルームを作成中…"],
"เชื่อมต่อเซิร์ฟเวอร์จับคู่ไม่ได้ ลองใหม่อีกครั้ง หรือเปลี่ยนเครือข่าย":["Couldn't reach the matchmaking server. Try again or switch networks","マッチングサーバーに接続できません。もう一度試すか、ネットワークを変えてください"],
"กำลังเข้าห้อง {c}…":["Joining room {c}…","ルーム{c}に入室中…"],
"กำลังเปิดห้อง {c} อีกครั้ง…":["Reopening room {c}…","ルーム{c}を開き直し中…"],
"รอเซิร์ฟเวอร์ปล่อยรหัสห้องเดิม":["Waiting for the server to release the old code","サーバーが元のコードを解放するのを待っています"],
"เปิดห้องเดิมไม่ได้":["Couldn't reopen the room","ルームを開き直せませんでした"],
"ลองใหม่อีกครั้งในอีกสักครู่":["Try again in a moment","少し待ってからもう一度お試しください"],
"เข้าห้องไม่ได้":["Couldn't join","入室できませんでした"],
"ไม่เจอห้อง {c} หรือเจ้าของห้องปิดเกมไปแล้ว":["Room {c} wasn't found, or the host closed the game","ルーム{c}が見つからないか、ホストがゲームを閉じました"],
"ถ้าใช้เน็ตมือถือ ลองเปลี่ยนเป็น Wi-Fi ดูก่อน บางเครือข่ายเชื่อมเครื่องต่อเครื่องไม่ได้":["On mobile data? Try Wi-Fi — some networks block device-to-device connections","モバイル通信ならWi-Fiを試してください。端末同士で接続できないネットワークもあります"],
"เวอร์ชันนี้อ่านภาพจากโฟลเดอร์ <b>cards</b> ใน GitHub repo ของเกม":["This version loads card art from the <b>cards</b> folder in the game's GitHub repo","この版はゲームのGitHubリポジトリの<b>cards</b>フォルダから画像を読み込みます"]
});
