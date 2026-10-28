(() => {
  "use strict";
  const cfg = window.GOW_CONFIG || {};
  const $ = id => document.getElementById(id);
  const state = { supabase:null, user:null, profile:null, people:[], active:null, messages:[], channel:null, peopleChannel:null, callChannel:null, pc:null, localStream:null, remoteStream:null, callId:null, callInitiator:false, pendingOffer:null, callSeen:new Set(), cleanupTimer:null, signupMode:false };
  const BUCKET = "chat-media";
  const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

  function toast(msg, ms=3600) { const el=$("toast"); el.textContent=msg; el.classList.add("show"); clearTimeout(state.toastTimer); state.toastTimer=setTimeout(()=>el.classList.remove("show"),ms); }
  function errText(e) { return e?.message || String(e || "Unknown error"); }
  function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
  function initials(s) { return (s||"?").trim().split(/\s+/).slice(0,2).map(x=>x[0]||"").join("").toUpperCase() || "?"; }
  function niceName(p) { return p?.display_name || p?.email || "Someone"; }
  function timeLabel(iso) { return new Date(iso).toLocaleTimeString([], {hour:"numeric",minute:"2-digit"}); }
  function expiryLabel(iso) { const mins=Math.max(0,Math.ceil((new Date(iso)-Date.now())/60000)); return mins<60?`${mins}m left`:`${Math.floor(mins/60)}h ${mins%60}m left`; }
  function showApp(on) { $("authPanel").classList.toggle("hidden",on); $("appPanel").classList.toggle("hidden",!on); $("signoutBtn").classList.toggle("hidden",!on); }
  function requireConfig() {
    if (!window.supabase || !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR_PROJECT_ID") || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY.includes("YOUR_SUPABASE")) {
      $("authNote").textContent="Setup needed: edit config.js with your Supabase project URL and anon/publishable key, then reload.";
      $("loginBtn").disabled=true; $("showSignupBtn").disabled=true; return false;
    }
    state.supabase=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    return true;
  }

  async function init() {
    if (!requireConfig()) return;
    $("showSignupBtn").addEventListener("click",()=>{state.signupMode=!state.signupMode;$("usernameWrap").classList.toggle("hidden",!state.signupMode);$("loginBtn").textContent=state.signupMode?"Create account":"Sign in";$("showSignupBtn").textContent=state.signupMode?"Back to sign in":"Create account";$("authNote").textContent=state.signupMode?"Use an email you can access. Supabase may send a confirmation link.":"New accounts may need to confirm their email.";});
    $("authForm").addEventListener("submit",authSubmit);
    $("signoutBtn").addEventListener("click",async()=>{await endCall(false);await state.supabase.auth.signOut();});
    $("peopleSearch").addEventListener("input",renderPeople);
    $("composer").addEventListener("submit",sendText);
    $("mediaInput").addEventListener("change",uploadMedia);
    $("voiceCallBtn").addEventListener("click",()=>startCall(false));
    $("videoCallBtn").addEventListener("click",()=>startCall(true));
    $("hangupBtn").addEventListener("click",()=>endCall(true));
    state.supabase.auth.onAuthStateChange((_event,session)=>{setTimeout(()=>session?.user?loadApp(session.user):resetToAuth(),0);});
    const {data:{session},error}=await state.supabase.auth.getSession();
    if(error) toast(errText(error));
    if(session?.user) await loadApp(session.user);
  }

  async function authSubmit(e) {
    e.preventDefault(); const email=$("email").value.trim(),password=$("password").value;
    $("loginBtn").disabled=true;
    try {
      if(state.signupMode) {
        const {data,error}=await state.supabase.auth.signUp({email,password,options:{data:{display_name:$("displayName").value.trim()||email.split("@")[0]}}});
        if(error) throw error;
        if(data.session) await loadApp(data.user); else toast("Account created. Check your email if confirmation is enabled.");
      } else {
        const {data,error}=await state.supabase.auth.signInWithPassword({email,password}); if(error) throw error; await loadApp(data.user);
      }
    } catch(e2) { toast(errText(e2)); } finally {$("loginBtn").disabled=false;}
  }
  async function resetToAuth() {
    state.user=null;state.profile=null;state.people=[];state.active=null;state.messages=[];
    if(state.channel) await state.supabase?.removeChannel(state.channel); state.channel=null;
    if(state.peopleChannel) await state.supabase?.removeChannel(state.peopleChannel);state.peopleChannel=null;
    showApp(false);
  }
  async function loadApp(user) {
    if(!user || !state.supabase) return;
    state.user=user;
    const {data:profile,error}=await state.supabase.from("profiles").select("*").eq("id",user.id).maybeSingle();
    if(error) { toast("Could not load profile: "+errText(error)); return; }
    state.profile=profile;
    showApp(true);
    await loadPeople();
    subscribePeople();
    if(state.cleanupTimer) clearInterval(state.cleanupTimer);
    state.cleanupTimer=setInterval(()=>{renderMessages();},30000);
  }

  async function loadPeople() {
    const {data,error}=await state.supabase.from("profiles").select("id,display_name,email,created_at").neq("id",state.user.id).order("display_name");
    if(error){toast("Could not load users: "+errText(error));return;}
    state.people=data||[];renderPeople();
  }
  function renderPeople() {
    const q=$("peopleSearch").value.trim().toLowerCase();
    const people=state.people.filter(p=>(niceName(p)+" "+(p.email||"")).toLowerCase().includes(q));
    $("peopleList").innerHTML="";
    if(!people.length){$("peopleList").innerHTML='<p class="muted tiny">No people found yet. Ask a friend to create an account.</p>';return;}
    people.forEach(p=>{
      const b=document.createElement("button");b.className="person"+(state.active?.id===p.id?" active":"");b.innerHTML=`<span class="avatar">${escapeHtml(initials(niceName(p)))}</span><span class="person-info"><strong>${escapeHtml(niceName(p))}</strong><small>${escapeHtml(p.email||"Gow/theFlow user")}</small></span>`;
      b.addEventListener("click",()=>openChat(p));$("peopleList").appendChild(b);
    });
  }
  function subscribePeople() {
    if(state.peopleChannel) state.supabase.removeChannel(state.peopleChannel);
    state.peopleChannel=state.supabase.channel("profiles-live").on("postgres_changes",{event:"*",schema:"public",table:"profiles"},()=>loadPeople()).subscribe();
  }
  async function openChat(person) {
    state.active=person;renderPeople();
    $("emptyState").classList.add("hidden");$("conversation").classList.remove("hidden");
    $("chatAvatar").textContent=initials(niceName(person));$("chatName").textContent=niceName(person);$("chatStatus").textContent="Messages expire 12 hours after sending";
    if(state.channel) await state.supabase.removeChannel(state.channel);
    await loadMessages();
    const ids=[state.user.id,person.id].sort();
    state.channel=state.supabase.channel("chat-"+ids.join("-"))
      .on("postgres_changes",{event:"*",schema:"public",table:"messages",filter:`sender_id=eq.${person.id}`},payload=>{if(payload.new?.recipient_id===state.user.id || payload.eventType==="DELETE") loadMessages();})
      .on("postgres_changes",{event:"*",schema:"public",table:"messages",filter:`sender_id=eq.${state.user.id}`},()=>loadMessages())
      .subscribe();
    $("messageInput").focus();
  }
  async function loadMessages() {
    if(!state.active) return;
    const other=state.active.id;
    const {data,error}=await state.supabase.from("messages").select("*")
      .or(`and(sender_id.eq.${state.user.id},recipient_id.eq.${other}),and(sender_id.eq.${other},recipient_id.eq.${state.user.id})`)
      .gt("expires_at",new Date().toISOString()).order("created_at",{ascending:true}).limit(300);
    if(error){toast("Could not load messages: "+errText(error));return;}
    state.messages=data||[];renderMessages();
  }
  function renderMessages() {
    const box=$("messages");if(!box)return;
    const atBottom=box.scrollHeight-box.scrollTop-box.clientHeight<90;
    const live=state.messages.filter(m=>new Date(m.expires_at).getTime()>Date.now());
    box.innerHTML="";
    if(!live.length){box.innerHTML='<div class="day-label">Say hello — your messages will expire in 12 hours.</div>';return;}
    live.forEach(m=>{
      const mine=m.sender_id===state.user.id,wrap=document.createElement("div");wrap.className="message"+(mine?" mine":"");
      const bubble=document.createElement("div");bubble.className="bubble";
      if(m.body) { const t=document.createElement("div");t.textContent=m.body;bubble.appendChild(t); }
      if(m.media_path) {
        const placeholder=document.createElement("div");placeholder.className="media-link";placeholder.textContent="Loading media…";bubble.appendChild(placeholder);
        state.supabase.storage.from(BUCKET).createSignedUrl(m.media_path, 300).then(({data,error})=>{
          if(error || !data?.signedUrl){placeholder.textContent="Media unavailable or expired";return;}
          if(m.media_type?.startsWith("image/")) {const img=document.createElement("img");img.src=data.signedUrl;img.alt="Shared image";img.className="media-preview";img.loading="lazy";placeholder.replaceWith(img);}
          else if(m.media_type?.startsWith("video/")) {const video=document.createElement("video");video.src=data.signedUrl;video.controls=true;video.playsInline=true;video.className="media-preview";placeholder.replaceWith(video);}
          else {const a=document.createElement("a");a.href=data.signedUrl;a.target="_blank";a.rel="noopener";a.textContent="Open shared file";a.className="media-link";placeholder.replaceWith(a);}
        }).catch(()=>{placeholder.textContent="Media unavailable or expired";});
      }
      const meta=document.createElement("div");meta.className="message-meta";meta.textContent=`${mine?"You":niceName(state.active)} · ${timeLabel(m.created_at)} · ${expiryLabel(m.expires_at)}`;
      wrap.append(bubble,meta);box.appendChild(wrap);
    });
    if(atBottom) box.scrollTop=box.scrollHeight;
  }
  async function sendText(e) {
    e.preventDefault();const input=$("messageInput"),body=input.value.trim();if(!body||!state.active)return;
    input.value="";$("sendBtn").disabled=true;
    try {
      const {error}=await state.supabase.from("messages").insert({sender_id:state.user.id,recipient_id:state.active.id,body});
      if(error) throw error;await loadMessages();
    } catch(e2){input.value=body;toast(errText(e2));} finally{$("sendBtn").disabled=false;input.focus();}
  }
  async function uploadMedia(e) {
    const file=e.target.files?.[0];e.target.value="";if(!file||!state.active)return;
    if(file.size>25*1024*1024){toast("For this starter, files must be 25 MB or smaller.");return;}
    if(!file.type.startsWith("image/")&&!file.type.startsWith("video/")){toast("Choose an image or video.");return;}
    toast("Uploading media…",10000);
    const safe=file.name.replace(/[^a-zA-Z0-9._-]/g,"_").slice(-100);
    const path=`${state.user.id}/${Date.now()}-${crypto.randomUUID()}-${safe}`;
    try {
      const {error:upErr}=await state.supabase.storage.from(BUCKET).upload(path,file,{contentType:file.type,upsert:false});
      if(upErr)throw upErr;
      const {error}=await state.supabase.from("messages").insert({sender_id:state.user.id,recipient_id:state.active.id,body:"",media_path:path,media_type:file.type});
      if(error){await state.supabase.storage.from(BUCKET).remove([path]);throw error;}
      await loadMessages();toast("Media sent. It expires in 12 hours.");
    } catch(e2){toast("Upload failed: "+errText(e2));}
  }

  // WebRTC: Supabase Realtime broadcasts signaling only. This basic version handles one-to-one calls.
  async function setupCallChannel() {
    if(state.callChannel) await state.supabase.removeChannel(state.callChannel);
    const pair=[state.user.id,state.active.id].sort().join("-");
    state.callChannel=state.supabase.channel("call-"+pair,{config:{broadcast:{self:false}}});
    state.callChannel.on("broadcast",{event:"signal"},async ({payload})=>{
      if(!payload||payload.from===state.user.id)return;
      if(payload.type==="offer") {
        if(state.callId && payload.callId!==state.callId) return;
        state.callId=payload.callId;
      } else if(payload.callId!==state.callId) return;
      try {
        if(payload.type==="offer") {
          state.pendingOffer=payload;
          $("callStatus").textContent=`Incoming ${payload.video?"video":"voice"} call`;
          if(confirm(`${niceName(state.active)} is calling. Answer?`)) await answerCall(payload);
          else {await sendSignal({type:"reject"});await endCall(false);}
        } else if(payload.type==="answer"&&state.pc) {
          await state.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        } else if(payload.type==="candidate"&&state.pc&&payload.candidate) {
          try {await state.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));} catch {}
        } else if(payload.type==="reject") {toast("Call declined.");await endCall(false);}
        else if(payload.type==="hangup") {toast("Call ended.");await endCall(false);}
      } catch(e){toast("Call signaling error: "+errText(e));}
    }).subscribe(status=>{if(status==="SUBSCRIBED"&&state.pendingOffer&&state.pendingOffer.callId===state.callId){}});
  }
  async function sendSignal(payload) {
    if(!state.callChannel)return;
    await state.callChannel.send({type:"broadcast",event:"signal",payload:{...payload,callId:state.callId,from:state.user.id}});
  }
  async function preparePeer(video) {
    state.pc=new RTCPeerConnection(ICE);state.remoteStream=new MediaStream();
    $("remoteVideo").srcObject=state.remoteStream;$("remoteAudio").srcObject=state.remoteStream;
    state.pc.ontrack=e=>{e.streams[0]?.getTracks().forEach(t=>state.remoteStream.addTrack(t));};
    state.pc.onicecandidate=e=>{if(e.candidate)sendSignal({type:"candidate",candidate:e.candidate.toJSON()});};
    state.pc.onconnectionstatechange=()=>{if(state.pc&&["failed","disconnected"].includes(state.pc.connectionState))toast("Call connection interrupted. Try again or check your network.");};
    state.localStream=await navigator.mediaDevices.getUserMedia({audio:true,video:video?{facingMode:"user"}:false});
    state.localStream.getTracks().forEach(t=>state.pc.addTrack(t,state.localStream));
    $("localVideo").srcObject=state.localStream;
    $("localVideo").classList.toggle("hidden",!video);$("remoteVideo").classList.toggle("hidden",!video);
    $("callPanel").classList.remove("hidden");
  }
  async function startCall(video) {
    if(!state.active){toast("Choose someone to call first.");return;}
    if(!navigator.mediaDevices?.getUserMedia){toast("Calls need a supported browser and HTTPS (GitHub Pages provides HTTPS).");return;}
    try {
      state.callId=crypto.randomUUID();state.callInitiator=true;
      await setupCallChannel();await preparePeer(video);
      const offer=await state.pc.createOffer();await state.pc.setLocalDescription(offer);
      await sendSignal({type:"offer",sdp:offer,video});
      $("callStatus").textContent=`Calling ${niceName(state.active)}…`;
    } catch(e){toast("Could not start call: "+errText(e));await endCall(false);}
  }
  async function answerCall(payload) {
    try {
      state.callId=payload.callId;state.callInitiator=false;
      await setupCallChannel();await preparePeer(!!payload.video);
      await state.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      const answer=await state.pc.createAnswer();await state.pc.setLocalDescription(answer);
      await sendSignal({type:"answer",sdp:answer});
      $("callStatus").textContent=`In call with ${niceName(state.active)}`;
    } catch(e){toast("Could not answer: "+errText(e));await endCall(false);}
  }
  async function endCall(notify=true) {
    if(notify&&state.callChannel&&state.callId){try{await sendSignal({type:"hangup"});}catch{}}
    if(state.localStream)state.localStream.getTracks().forEach(t=>t.stop());
    if(state.pc){state.pc.close();state.pc=null;}state.localStream=null;state.remoteStream=null;
    $("localVideo").srcObject=null;$("remoteVideo").srcObject=null;$("remoteAudio").srcObject=null;
    $("callPanel").classList.add("hidden");
    if(state.callChannel)await state.supabase.removeChannel(state.callChannel);state.callChannel=null;state.callId=null;state.pendingOffer=null;
  }
  init();
})();
