'use strict';
// ===== รถไฟเศรษฐีไทย · เวอร์ชันเว็บแยก (GitHub Pages) =====
// แทนที่ระบบออนไลน์ของ Claude ด้วย PeerJS: เจ้าของห้องถือสถานะเกม เพื่อนต่อเข้ามาด้วยรหัสห้อง ไม่ต้องมีบัญชี

const P2P={peer:null,conns:[],host:false,code:null,doc:null,listeners:[],hostConn:null,retry:null,closing:false};
const PREFIX="rotfai-setthi-";
function myPid(){ let id=null; try{id=localStorage.getItem("rotfai-pid");}catch(e){} if(!id){ id="p_"+Math.random().toString(36).slice(2,12); try{localStorage.setItem("rotfai-pid",id);}catch(e){} } return id; }
function snapOf(doc){ return {exists:!!doc, data:()=>doc?JSON.parse(JSON.stringify(doc)):undefined}; }
function notifyLocal(){ const s=snapOf(P2P.doc); P2P.listeners.forEach(fn=>{ try{fn(s);}catch(e){console.error(e);} }); }
function hostSave(){ try{ if(P2P.doc) localStorage.setItem("rotfai-host-"+P2P.code,JSON.stringify(P2P.doc)); else localStorage.removeItem("rotfai-host-"+P2P.code);}catch(e){} }
function broadcast(){ const m={t:"doc",doc:P2P.doc}; P2P.conns.forEach(c=>{ try{ if(c.open) c.send(m);}catch(e){} }); }
function hostApply(fn){ fn(); hostSave(); broadcast(); setTimeout(notifyLocal,0); }

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
function sendHost(m){ const c=P2P.hostConn; if(c&&c.open){ try{c.send(m);}catch(e){} } else toast("ยังต่อกับเจ้าของห้องไม่ได้ กำลังลองใหม่…"); }

function hostHandle(conn,m){
  if(!m||typeof m!=="object") return;
  if(m.t==="join"){
    const d=P2P.doc; if(!d) return;
    if(!(d.seats||[]).some(s=>s.uid===m.uid)){
      if(d.status!=="lobby"){ conn.send({t:"err",msg:"ห้องนี้เริ่มเล่นไปแล้ว"}); return; }
      if(d.seats.length>=4){ conn.send({t:"err",msg:"ห้องเต็มแล้ว"}); return; }
      hostApply(()=>{ d.seats=[...d.seats,{uid:m.uid,co:"รถไฟ"+PCOL[d.seats.length][0]}]; });
    } else conn.send({t:"doc",doc:P2P.doc});
  } else if(m.t==="set"&&m.body){ hostApply(()=>{P2P.doc=m.body;}); }
  else if(m.t==="update"&&m.p){ hostApply(()=>{P2P.doc={...P2P.doc,...m.p};}); }
  else if(m.t==="leave"){ if(P2P.doc&&P2P.doc.status==="lobby") hostApply(()=>{P2P.doc.seats=P2P.doc.seats.filter(s=>s.uid!==m.uid);}); }
}
function loadPeerLib(){
  if(window.Peer) return Promise.resolve(true);
  return new Promise(res=>{ const s=document.createElement("script"); s.src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"; s.onload=()=>res(true); s.onerror=()=>res(false); document.head.appendChild(s); });
}
function closePeer(){ P2P.closing=true; clearTimeout(P2P.retry); try{P2P.peer&&P2P.peer.destroy();}catch(e){} P2P.peer=null; P2P.conns=[]; P2P.hostConn=null; P2P.listeners=[]; P2P.doc=null; P2P.host=false; setTimeout(()=>{P2P.closing=false;},50); }

function startHost(code,doc){
  return new Promise(res=>{
    closePeer(); P2P.host=true; P2P.code=code; P2P.doc=doc;
    const peer=new Peer(PREFIX+code); P2P.peer=peer;
    peer.on("open",()=>{ hostSave(); res(true); });
    peer.on("connection",conn=>{
      P2P.conns.push(conn);
      conn.on("open",()=>{ conn.send({t:"doc",doc:P2P.doc}); });
      conn.on("data",m=>hostHandle(conn,m));
      conn.on("close",()=>{ P2P.conns=P2P.conns.filter(c=>c!==conn); });
    });
    peer.on("error",e=>{ if(e.type==="unavailable-id"){ res("taken"); } else if(e.type==="network"||e.type==="server-error"||e.type==="socket-error"){ toast("เชื่อมต่อเซิร์ฟเวอร์จับคู่ไม่ได้ ตรวจอินเทอร์เน็ต"); res(false); } });
    peer.on("disconnected",()=>{ if(!P2P.closing){ try{peer.reconnect();}catch(e){} } });
  });
}
function startGuest(code){
  return new Promise(res=>{
    closePeer(); P2P.host=false; P2P.code=code;
    const peer=new Peer(); P2P.peer=peer; let done=false;
    const connect=()=>{
      const conn=peer.connect(PREFIX+code,{reliable:true}); P2P.hostConn=conn;
      const t=setTimeout(()=>{ if(!done){done=true;res(false);} },9000);
      conn.on("open",()=>{ conn.send({t:"join",uid:ON.me}); });
      conn.on("data",m=>{
        if(m&&m.t==="doc"){ P2P.doc=m.doc; if(!done){ if(!m.doc) return; clearTimeout(t); done=true; res(true); return; } notifyLocal(); }
        else if(m&&m.t==="err"){ toast(m.msg); if(!done){ clearTimeout(t); done=true; res(false); } }
      });
      conn.on("close",()=>{ if(P2P.closing||!P2P.peer) return; toast("หลุดจากเจ้าของห้อง กำลังต่อใหม่…"); P2P.retry=setTimeout(connect,3000); });
    };
    peer.on("open",connect);
    peer.on("error",e=>{ if(e.type==="peer-unavailable"){ if(!done){done=true;res(false);} else { P2P.retry=setTimeout(connect,4000); } } else if(!done&&(e.type==="network"||e.type==="server-error"||e.type==="socket-error")){ done=true; res(false); } });
  });
}

// ---------- แทนที่ฟังก์ชันออนไลน์ของเวอร์ชัน Claude ----------
async function initOnline(){
  const ok=await loadPeerLib(); if(!ok) return false;
  ON.me=myPid();
  ON.user={profiles:async()=>({}),can:async()=>true,id:async()=>ON.me};
  ON.db={doc:()=>makeRef(),collection:()=>({where:()=>({limit:()=>({onSnapshot:()=>()=>{}})})})};
  return true;
}
function leaveOnline(){
  if(ON.unsub){ON.unsub();ON.unsub=null;}
  closePeer();
  ON.ref=null; ON.meta=null; ON.handledTurn=null; ON.seenMove=null; ON.seenReport=null; ON.shownOver=false; ON.seenLog=0;
  MODE="local";
}
async function roomList(){
  while(true){
    const html=`<div class="stack"><button class="mode-btn primary" data-val="create"><b>สร้างห้องใหม่</b><span>ได้รหัส 4 ตัว ส่งให้เพื่อนพร้อมลิงก์เกม</span></button></div>
      <div class="field"><div class="label">หรือใส่รหัสห้องของเพื่อน</div>
      <div style="display:flex;gap:8px;margin-top:6px"><input id="roomCode" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="เช่น P8CS" style="flex:1;min-width:0;min-height:48px;border-radius:12px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink);padding:0 14px;font:600 20px var(--font-d);letter-spacing:.2em;text-transform:uppercase" aria-label="รหัสห้อง"><button class="btn primary" style="flex:none" data-val="join">เข้าห้อง</button></div></div>
      <p class="note">เพื่อนเปิดลิงก์เดียวกัน กด "เล่นออนไลน์กับเพื่อน" แล้วใส่รหัสห้อง ไม่ต้องสมัครอะไร</p>`;
    const p=modal({eyebrow:"เล่นออนไลน์",title:"เข้าห้องเล่น",html,buttons:[{label:"กลับ",value:"back"}]});
    const inp=$("roomCode"); if(inp){ setTimeout(()=>inp.focus(),50); inp.onkeydown=e=>{ if(e.key==="Enter"){ e.preventDefault(); $("modal").querySelector('[data-val="join"]').click(); } }; }
    const v=await p;
    const code=($("roomCode")?.value||"").trim().toUpperCase();
    if(v==="back"||v===undefined) return home();
    if(v==="create") return createRoom();
    if(v==="join"){ if(!/^[A-Z0-9]{4}$/.test(code)){ toast("รหัสห้องต้องมี 4 ตัว"); continue; } return joinRoom(code); }
  }
}
async function createRoom(){
  modal({title:"กำลังสร้างห้อง…",html:"",buttons:[]});
  for(let tries=0;tries<4;tries++){
    const code=genCode();
    const doc={code,status:"lobby",host:ON.me,created:Date.now(),years:1,quiz:true,qTime:5,seats:[{uid:ON.me,co:"รถไฟแดง"}],rev:0};
    const r=await startHost(code,doc);
    if(r===true){ enterRoom(code); return; }
    if(r===false) break;
  }
  await info("สร้างห้องไม่ได้","เชื่อมต่อเซิร์ฟเวอร์จับคู่ไม่ได้ ลองใหม่อีกครั้ง หรือเปลี่ยนเครือข่าย");
  return roomList();
}
async function joinRoom(code){
  code=String(code).toUpperCase();
  modal({title:"กำลังเข้าห้อง "+esc(code)+"…",html:"",buttons:[]});
  let saved=null; try{ saved=JSON.parse(localStorage.getItem("rotfai-host-"+code)||"null"); }catch(e){}
  if(saved&&saved.host===ON.me){
    for(let i=0;i<5;i++){ const r=await startHost(code,saved); if(r===true){ enterRoom(code); return; } if(r===false) break; await sleep(2500); }
    await info("เปิดห้องเดิมไม่ได้","ลองใหม่อีกครั้งในอีกสักครู่"); return roomList();
  }
  const ok=await startGuest(code);
  if(!ok){ await info("เข้าห้องไม่ได้",`ไม่เจอห้อง ${esc(code)} หรือเจ้าของห้องปิดเกมไปแล้ว<p class="note">ถ้าใช้เน็ตมือถือ ลองเปลี่ยนเป็น Wi-Fi ดูก่อน บางเครือข่ายเชื่อมเครื่องต่อเครื่องไม่ได้</p>`); try{localStorage.removeItem("rotfai-room");}catch(e){} return roomList(); }
  enterRoom(code);
}
// ภาพการ์ด: อ่านจากโฟลเดอร์ cards/ ใน repo (เช่น cards/P01.webp)
function gcArt(id){ return `<img src="cards/${id}.webp" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;gc-ph&quot;>ภาพ ${id}</span>'">`; }
async function initArt(){}
async function manageArt(){
  await info("ภาพการ์ด",`<p>เวอร์ชันนี้อ่านภาพจากโฟลเดอร์ <b>cards</b> ใน GitHub repo ของเกม</p><p>ใช้สคริปต์ <b>prepare_cards.py</b> แปลงภาพจาก ComfyUI ให้เป็นชื่อ P01.webp, D01.webp … แล้วลากไฟล์ทั้งหมดไปวางในโฟลเดอร์ cards บนหน้าเว็บ GitHub</p>`);
}

// ข้อความในห้องรอให้ตรงกับเวอร์ชันนี้ (ใส่รหัสแทนการเลือกห้อง)
(function(){ const _draw=drawRoom; drawRoom=async function(d){ const r=_draw(d); setTimeout(()=>{ const p=document.querySelector("#modal .body p"); if(p&&p.textContent.includes("เลือกห้องนี้")) p.textContent="บอกรหัสนี้ให้เพื่อน แล้วให้เพื่อนเปิดลิงก์เดียวกัน กด \"เล่นออนไลน์กับเพื่อน\" แล้วพิมพ์รหัสห้อง"; },0); return r; }; })();
