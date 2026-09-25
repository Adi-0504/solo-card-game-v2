(() => {
  'use strict';
  const THREE = window.THREE;
  const gsap = window.gsap;
  if (!THREE) return;

  const SUITS = [
    { name: 'cross', glyph: '✦', color: '#b85c4d' },
    { name: 'triangle', glyph: '▲', color: '#397c72' },
    { name: 'square', glyph: '■', color: '#47719a' },
    { name: 'diamond', glyph: '◆', color: '#b18446' }
  ];
  const VICTORY_GROUPS = 4;
  const CARD_W = 1.14, CARD_H = 1.9, CARD_D = .115;
  const sceneEl = document.getElementById('scene');
  const liveRegion = document.getElementById('liveRegion');

  class RNG {
    constructor(seed = 0x6d2b79f5) { this.state = seed >>> 0 || 1; }
    next() { let t = this.state += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }
    card() { return { number: 1 + Math.floor(this.next() * 13), suit: Math.floor(this.next() * 4) }; }
    serialize() { return this.state >>> 0; }
  }

  const GameState = {
    version: 4,
    phase: 'PLAYING', hand: [], tableRow: [], completedGroups: [], rngState: 0, moves: 0, rescuesUsed: 0,
    mode: 'SOLO', racePlayer: 1, raceResults: [], raceStartedAt: 0,
    settings: { sound: true, haptics: true, reduceMotion: false, highContrast: false, seenIntro: false }
  };
  let rng = new RNG();
  function getOnlineWsUrl() {
    if (window.SOLO_CARD_GAME_CONFIG?.wsUrl) return window.SOLO_CARD_GAME_CONFIG.wsUrl;
    const paramWs = new URLSearchParams(location.search).get('ws');
    if (paramWs) return paramWs;
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${location.host}/ws`;
    }
    return '';
  }
  let onlineSocket=null, onlineRoomCode='', onlineToken='', onlinePending=null, onlineReconnectTimer=0;

  function cloneCard(c) { return { number: c.number, suit: c.suit, id: c.id }; }
  function makeCard() { const c = rng.card(); return { ...c, id: `card-${rng.serialize().toString(36)}` }; }
  function initialState() { rng = new RNG((Date.now() ^ 0x41a7f3) >>> 0); GameState.phase='PLAYING'; GameState.hand = Array.from({length:13}, makeCard); GameState.tableRow=[]; GameState.completedGroups=[]; GameState.moves=0; GameState.rescuesUsed=0; GameState.raceStartedAt=GameState.mode==='RACE'?Date.now():0; GameState.rngState=rng.serialize(); }

  const DB = {
    async open() { if(!window.indexedDB)return null; return new Promise((resolve,reject)=>{ const req=indexedDB.open('solo-card-game',1); req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('state'))req.result.createObjectStore('state');}; req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error); }); },
    async get() { try { const db=await this.open(); if(!db)return null; return new Promise((resolve,reject)=>{ const tx=db.transaction('state','readonly'); const req=tx.objectStore('state').get('current'); req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error); }); } catch { return null; } },
    async put(value) { try { const db=await this.open(); if(!db)return; return new Promise((resolve,reject)=>{ const tx=db.transaction('state','readwrite'); tx.objectStore('state').put(value,'current'); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); }); } catch {} }
  };
  function serializableState() { return {version:4, phase:GameState.phase, hand:GameState.hand.map(cloneCard), tableRow:GameState.tableRow.map(cloneCard), completedGroups:GameState.completedGroups.map(g=>({cards:g.cards.map(cloneCard),rules:[...g.rules]})), rngState:rng.serialize(), moves:GameState.moves||0, rescuesUsed:GameState.rescuesUsed||0, mode:GameState.mode||'SOLO', racePlayer:GameState.racePlayer||1, raceResults:GameState.raceResults||[], raceStartedAt:GameState.raceStartedAt||0, settings:{...GameState.settings}}; }
  async function save() { GameState.rngState=rng.serialize(); await DB.put(serializableState()); }
  function validCard(c) { return c&&Number.isInteger(c.number)&&c.number>=1&&c.number<=13&&Number.isInteger(c.suit)&&c.suit>=0&&c.suit<4&&typeof c.id==='string'; }
  function validSave(s) { if(!s||s.version!==4||!['PLAYING','PAUSED','WON','LOST'].includes(s.phase)||!Array.isArray(s.hand)||!s.hand.every(validCard)||!Array.isArray(s.tableRow)||!s.tableRow.every(validCard)||!Array.isArray(s.completedGroups)||!s.completedGroups.every(g=>g&&Array.isArray(g.cards)&&g.cards.every(validCard)&&Array.isArray(g.rules)))return false; const ids=[...s.hand,...s.tableRow,...s.completedGroups.flatMap(g=>g.cards)].map(c=>c.id); return new Set(ids).size===ids.length&&Number.isInteger(s.rngState); }
  function migrateSave(s) { if(!s||!Array.isArray(s.hand)||!Array.isArray(s.tableRow)||!Array.isArray(s.completedGroups))return null; if(s.version===1||s.version===2||s.version===3){s.completedGroups=s.completedGroups.map(g=>Array.isArray(g)?{cards:g,rules:['sequence']}:{cards:g.cards||[],rules:g.rules||['sequence']});s.phase=s.phase||'PLAYING';s.version=4;} return s; }
  async function restore() { const loaded=migrateSave(await DB.get()); if (!validSave(loaded)) { initialState(); await save(); return; } Object.assign(GameState,loaded); GameState.moves=Number.isInteger(loaded.moves)?loaded.moves:0; GameState.rescuesUsed=Number.isInteger(loaded.rescuesUsed)?loaded.rescuesUsed:0; GameState.mode=['RACE','ONLINE'].includes(loaded.mode)?loaded.mode:'SOLO'; GameState.racePlayer=loaded.racePlayer===2?2:1; GameState.raceResults=Array.isArray(loaded.raceResults)?loaded.raceResults:[]; GameState.raceStartedAt=Number.isFinite(loaded.raceStartedAt)?loaded.raceStartedAt:0; GameState.completedGroups=(loaded.completedGroups||[]).map(g=>({cards:g.cards.map(cloneCard),rules:[...g.rules]})); rng=new RNG(loaded.rngState); GameState.settings={...GameState.settings,...(loaded.settings||{})}; if(GameState.phase==='LOST')GameState.phase='PLAYING'; if(!GameState.settings.seenIntro){initialState(); await save();} }

  const renderer = new THREE.WebGLRenderer({antialias:true, alpha:false, powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap; renderer.outputColorSpace=THREE.SRGBColorSpace; renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=.92; sceneEl.appendChild(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#10231f');
  const camera = new THREE.PerspectiveCamera(39, 1, .1, 100); camera.position.set(0, 7.2, 10.2); camera.lookAt(0, .65, -2.5);
  const world = new THREE.Group(); scene.add(world);
  scene.add(new THREE.HemisphereLight('#dce6d5','#10241d',1.55));
  const key = new THREE.DirectionalLight('#fff0d1',2.65); key.position.set(-5,10,6); key.castShadow=true; key.shadow.mapSize.set(2048,2048); key.shadow.camera.left=-9; key.shadow.camera.right=9; key.shadow.camera.top=9; key.shadow.camera.bottom=-9; world.add(key);
  const fill = new THREE.PointLight('#9cb9a3',.8,20); fill.position.set(4,4,-6); world.add(fill);
  function makeFeltTexture(){ const c=document.createElement('canvas'); c.width=128;c.height=128;const x=c.getContext('2d');x.fillStyle='#315e4a';x.fillRect(0,0,128,128);for(let i=0;i<1800;i++){const v=35+Math.floor(Math.random()*35);x.fillStyle=`rgba(${v},${v+28},${v+17},${.06+Math.random()*.08})`;x.fillRect(Math.random()*128,Math.random()*128,1,1);}const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(14,14);return t; }
  const table = new THREE.Mesh(new THREE.BoxGeometry(18,.72,17), new THREE.MeshStandardMaterial({color:'#3a281f',roughness:.84,metalness:.02})); table.position.set(0,-.5,-1.6); table.receiveShadow=true; world.add(table);
  const tableEdge = new THREE.Mesh(new THREE.BoxGeometry(18.1,.16,17.1), new THREE.MeshStandardMaterial({color:'#1b332a',roughness:.9})); tableEdge.position.y=-.12; tableEdge.position.z=-1.6; tableEdge.receiveShadow=true; world.add(tableEdge);
  const felt = new THREE.Mesh(new THREE.PlaneGeometry(16.9,15.9), new THREE.MeshStandardMaterial({map:makeFeltTexture(),color:'#789b76',roughness:.96})); felt.rotation.x=-Math.PI/2; felt.position.set(0,-.13,-1.6); felt.receiveShadow=true; world.add(felt);
  const walnut = new THREE.MeshStandardMaterial({color:'#2c1d18',roughness:.72,metalness:.04}); const frontApron = new THREE.Mesh(new THREE.BoxGeometry(18.2,.7,.42),walnut); frontApron.position.set(0,-.47,5.65); frontApron.castShadow=true; world.add(frontApron); const sideApronL=new THREE.Mesh(new THREE.BoxGeometry(.42,.7,16.8),walnut);sideApronL.position.set(-8.88,-.47,-1.6);sideApronL.castShadow=true;world.add(sideApronL);const sideApronR=sideApronL.clone();sideApronR.position.x=8.88;world.add(sideApronR);
  const mat = new THREE.MeshStandardMaterial({color:'#d6be8e',roughness:.78}); const farRail = new THREE.Mesh(new THREE.BoxGeometry(14.5,.05,.14), new THREE.MeshStandardMaterial({color:'#244838',roughness:.9})); farRail.position.set(0,-.06,-5.85); world.add(farRail);

  const cardMeshes = new Map(), raycaster=new THREE.Raycaster(), pointer=new THREE.Vector2(); let drag=null, previewIndex=null, busy=false;
  function textureFor(card) {
    const canvas=document.createElement('canvas'); canvas.width=360; canvas.height=600; const ctx=canvas.getContext('2d'); const high=GameState.settings.highContrast;
    ctx.fillStyle=high?'#ffffff':'#fcf8ed'; ctx.fillRect(0,0,360,600);
    const suitColor = high ? (card.suit===0?'#c43325':card.suit===1?'#1b7a65':card.suit===2?'#1d62a3':'#b87719') : SUITS[card.suit].color;
    ctx.strokeStyle=suitColor; ctx.lineWidth=14; ctx.strokeRect(10,10,340,580);
    ctx.fillStyle=high?'#000000':'#10241d'; ctx.font='900 110px Arial Black, Arial, sans-serif'; ctx.fillText(String(card.number),22,115);
    const numWidth = card.number >= 10 ? 135 : 75;
    ctx.fillStyle=suitColor; ctx.font='900 68px Georgia, serif'; ctx.fillText(SUITS[card.suit].glyph, 22 + numWidth + 10, 110);
    ctx.font='900 150px Georgia, serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(SUITS[card.suit].glyph,180,310);
    ctx.fillStyle=high?'#000000':'#10241d'; ctx.font='900 72px Arial Black, Arial, sans-serif'; ctx.fillText(String(card.number),180,515);
    ctx.font='700 32px Arial, sans-serif'; ctx.fillStyle=suitColor; ctx.fillText(SUITS[card.suit].name.toUpperCase(),180,560);
    ctx.textAlign='start'; ctx.textBaseline='alphabetic';
    const tex=new THREE.CanvasTexture(canvas); tex.colorSpace=THREE.SRGBColorSpace; return tex;
  }
  function roundedCardShape(){ const s=new THREE.Shape(),w=CARD_W/2,h=CARD_H,r=.07; s.moveTo(-w+r,0);s.lineTo(w-r,0);s.quadraticCurveTo(w,0,w,r);s.lineTo(w,h-r);s.quadraticCurveTo(w,h,w-r,h);s.lineTo(-w+r,h);s.quadraticCurveTo(-w,h,-w,h-r);s.lineTo(-w,r);s.quadraticCurveTo(-w,0,-w+r,0);return s; }
  function createCardMesh(card) { const group=new THREE.Group(); group.userData.cardId=card.id; group.userData.card=card; const body=new THREE.Mesh(new THREE.ExtrudeGeometry(roundedCardShape(),{depth:CARD_D,bevelEnabled:true,bevelSegments:2,steps:1,bevelSize:.028,bevelThickness:.022}),mat.clone()); body.position.z=-CARD_D/2; body.castShadow=true; body.receiveShadow=true; group.add(body); const face=new THREE.Mesh(new THREE.PlaneGeometry(CARD_W-.1,CARD_H-.1),new THREE.MeshStandardMaterial({map:textureFor(card),roughness:.6,metalness:0})); face.position.set(0,CARD_H/2,CARD_D/2+.035); face.castShadow=true; group.add(face); const back=new THREE.Mesh(new THREE.PlaneGeometry(CARD_W-.1,CARD_H-.1),new THREE.MeshStandardMaterial({color:'#376154',roughness:.72})); back.rotation.y=Math.PI; back.position.set(0,CARD_H/2,-CARD_D/2-.018); group.add(back); group.rotation.x=-.22; world.add(group); cardMeshes.set(card.id,group); return group; }
  function removeMesh(id){ const m=cardMeshes.get(id); if(m){ world.remove(m); m.traverse(o=>{if(o.geometry)o.geometry.dispose(); if(o.material){if(o.material.map)o.material.map.dispose();o.material.dispose();}}); cardMeshes.delete(id); } }
  function layoutCard(card,index,total,zone='hand',animate=true) {
    const w=innerWidth, h=innerHeight;
    const isPhone=w<600||h<600;
    const isTablet=!isPhone&&(w<=1024||h<=800);
    let x,z,rot,y;
    if(zone==='hand'){
      const maxSpan=isPhone?6.8:isTablet?8.6:11.8;
      const span=total<=1?0:Math.min(maxSpan,(isPhone?4.6:5.15)+total*(isPhone?.20:.22));
      const t=total===1?.5:index/(total-1);
      x=(t-.5)*span; z=.72+Math.abs(t-.5)*.46; rot=(t-.5)*-.11; y=.06;
    } else if(zone==='row'){
      const maxRowSpan=isPhone?7.6:isTablet?9.8:12.2;
      const span=Math.min(maxRowSpan, Math.max(1.5,total*(isPhone?1.15:1.3)));
      const t=total===1?.5:index/(total-1);
      x=(t-.5)*span; z=-1.45+Math.abs(t-.5)*.18; rot=(t-.5)*-.035; y=.06;
    } else {
      const cols=Math.min(7,total), row=Math.floor(index/cols), col=index%cols;
      x=(col-(Math.min(cols,total)-1)/2)*1.43; z=-4.75-row*1.35; rot=(col-(cols-1)/2)*-.025; y=.06;
    }
    const m=cardMeshes.get(card.id)||createCardMesh(card); m.userData.zone=zone;
    let scale=1.0;
    if(zone==='hand') scale=isPhone?1.32:isTablet?1.22:1.0;
    else if(zone==='row') scale=isPhone?1.26:isTablet?1.18:1.0;
    else if(zone==='completed') scale=isPhone?1.14:isTablet?1.10:1.0;
    m.scale.setScalar(scale);
    if(animate&&!GameState.settings.reduceMotion){gsap.to(m.position,{x,y,z,duration:.34,ease:'power2.out'});gsap.to(m.rotation,{y:rot,duration:.34,ease:'power2.out'});} else {m.position.set(x,y,z);m.rotation.y=rot;}
  }
  function syncMeshes(){ const completedCards=GameState.completedGroups.flatMap(g=>g.cards); const live=new Set([...GameState.hand,...GameState.tableRow,...completedCards].map(c=>c.id)); cardMeshes.forEach((_,id)=>{if(!live.has(id))removeMesh(id)}); GameState.hand.forEach((c,i)=>layoutCard(c,i,GameState.hand.length,'hand')); GameState.tableRow.forEach((c,i)=>layoutCard(c,i,GameState.tableRow.length,'row')); completedCards.forEach((c,i)=>layoutCard(c,i,completedCards.length,'completed')); }
  function cardAt(clientX,clientY){ const rect=renderer.domElement.getBoundingClientRect(); pointer.x=((clientX-rect.left)/rect.width)*2-1; pointer.y=-((clientY-rect.top)/rect.height)*2+1; raycaster.setFromCamera(pointer,camera); const hits=raycaster.intersectObjects([...cardMeshes.values()].map(m=>m.children[0])); return hits.find(h=>h.object.parent.userData.zone==='hand'); }
  function screenToTable(clientX,clientY){ const rect=renderer.domElement.getBoundingClientRect(); pointer.x=((clientX-rect.left)/rect.width)*2-1; pointer.y=-((clientY-rect.top)/rect.height)*2+1; raycaster.setFromCamera(pointer,camera); const plane=new THREE.Plane(new THREE.Vector3(0,1,0),0); const p=new THREE.Vector3(); raycaster.ray.intersectPlane(plane,p); return p; }
  function insertionFor(x){ const xs=GameState.tableRow.map(c=>cardMeshes.get(c.id)?.position.x||0); if(!xs.length)return 0; let best=0,dist=Infinity; for(let i=0;i<=xs.length;i++){const gap=i===0?xs[0]-1.0:i===xs.length?xs.at(-1)+1:(xs[i]+xs[i-1])/2;const d=Math.abs(x-gap);if(d<dist){dist=d;best=i;}} return best; }
  function feedback(text){liveRegion.textContent=text; if(GameState.settings.haptics&&navigator.vibrate&&(!navigator.userActivation||navigator.userActivation.isActive)){try{navigator.vibrate(8);}catch{}}}
  function moveRowForPreview(){ GameState.tableRow.forEach((c,i)=>{ const target=i>=previewIndex?i+1:i; layoutCard(c,target,GameState.tableRow.length+1,'row',false); }); }
  function moveHandForSelection(selected){ GameState.hand.forEach((c,i)=>{if(i!==selected)layoutCard(c,i+(i>selected?1:0),GameState.hand.length+1,'hand',false);}); }
  function beginDrag(e){ if(busy||GameState.phase!=='PLAYING')return; const hit=cardAt(e.clientX,e.clientY); if(!hit)return; const card=hit.object.parent.userData.card; const index=GameState.hand.findIndex(c=>c.id===card.id); if(index<0)return; e.preventDefault(); renderer.domElement.setPointerCapture?.(e.pointerId); const mesh=cardMeshes.get(card.id); drag={pointerId:e.pointerId,card,index,mesh,startX:e.clientX,startY:e.clientY,moved:false,offsetX:0}; mesh.position.y=.72; mesh.scale.setScalar(1.035); moveHandForSelection(index); feedback('已拿起牌'); }
  function dragMove(e){ if(!drag||e.pointerId!==drag.pointerId)return; const dx=e.clientX-drag.startX,dy=e.clientY-drag.startY; if(!drag.moved&&Math.hypot(dx,dy)<7)return; drag.moved=true; const p=screenToTable(e.clientX,e.clientY); drag.mesh.position.x=p.x; drag.mesh.position.z=Math.min(-.2,Math.max(-2.2,p.z)); drag.mesh.position.y=.72; const next=insertionFor(p.x); if(next!==previewIndex){previewIndex=next;moveRowForPreview();} }
  async function endDrag(e){ if(!drag||e.pointerId!==drag.pointerId)return; const current=drag; drag=null; previewIndex=null; renderer.domElement.releasePointerCapture?.(e.pointerId); if(!current.moved){current.mesh.scale.setScalar(1);syncMeshes();return;} const p=screenToTable(e.clientX,e.clientY); const index=insertionFor(p.x); busy=true; if(GameState.mode==='ONLINE'){syncMeshes();if(!sendOnline({type:'PLACE_CARD',cardId:current.card.id,index})){setOnlineStatus('正在連接線上伺服器…');}return;} const result=GameEngine.placeCard(current.card.id,index); if(!result.ok){feedback('牌回到手邊');showContextHint('這張牌接不上，請換一張或換個位置');if(GameState.settings.reduceMotion){syncMeshes();busy=false;}else{gsap.to(current.mesh.position,{y:.24,duration:.1,ease:'power2.out',yoyo:true,repeat:1,onComplete:()=>{syncMeshes();busy=false;}});gsap.to(current.mesh.rotation,{z:.035,duration:.1,yoyo:true,repeat:1,ease:'power1.inOut'});}return;} feedback('牌已放到桌面'); playTone(); syncMeshes(); if(result.completed?.length){feedback('牌面形成連續結構');showContextHint('完成一組，繼續建立下一組');} else if(result.rescued){feedback('桌面沒有可完成的牌組，已補入救援牌');showContextHint(`已補入四張 ${result.rescueNumber}，把它們排在一起即可完成`);} await save(); if(result.winner||result.loser)showResult(result.winner?'WON':'LOST'); setTimeout(()=>{if(!result.winner&&!result.loser)busy=false;}, GameState.settings.reduceMotion?30:360); }
  function cancelDrag(){ if(!drag)return; drag.mesh.position.y=.06;drag.mesh.scale.setScalar(1);drag=null;previewIndex=null;syncMeshes(); }
  renderer.domElement.addEventListener('pointerdown',beginDrag,{passive:false}); renderer.domElement.addEventListener('pointermove',dragMove,{passive:false}); renderer.domElement.addEventListener('pointerup',endDrag,{passive:false}); renderer.domElement.addEventListener('pointercancel',cancelDrag); renderer.domElement.addEventListener('pointerleave',e=>{if(drag&&e.pointerId===drag.pointerId)dragMove(e)});

  function isNext(a,b){ return b===a+1 || (a===13&&b===1); }
  function findFirstMaxRun(row){ let start=0; while(start<row.length){ if(start>0&&isNext(row[start-1].number,row[start].number)){start++;continue;} let end=start+1; while(end<row.length&&isNext(row[end-1].number,row[end].number))end++; if(end-start>=4)return {start,end,cards:row.slice(start,end)}; start=end; } return null; }
  function isLegalSequence(cards){ return cards.length>=4&&cards.every((c,i)=>i===0||isNext(cards[i-1].number,c.number)); }
  function isLegalSet(cards){ return cards.length>=4&&cards.every(c=>c.number===cards[0].number); }
  function candidateGroups(row){ const candidates=[]; for(let start=0;start<row.length;start++){ for(let end=start+4;end<=row.length;end++){ const cards=row.slice(start,end); const sequence=isLegalSequence(cards); const sameNumber=isLegalSet(cards); if(!sequence&&!sameNumber)continue; const rules=[]; if(sequence){rules.push('sequence');if(cards.every(c=>c.suit===cards[0].suit))rules.push('same-suit-sequence');} if(sameNumber)rules.push('same-number-set'); candidates.push({start,end,cards,rules}); } } return candidates; }
  function groupsForPlacement(row,card,index){ const next=row.slice(); next.splice(index,0,card); return candidateGroups(next); }
  function chooseGroups(candidates){ let best=[]; const visit=(at,chosen)=>{ if(chosen.length>best.length||(chosen.length===best.length&&chosen.reduce((n,g)=>n+g.cards.length,0)<best.reduce((n,g)=>n+g.cards.length,0)))best=chosen.slice(); for(let i=at;i<candidates.length;i++){const g=candidates[i];if(chosen.every(x=>g.end<=x.start||g.start>=x.end))visit(i+1,[...chosen,g]);} }; visit(0,[]); return best.sort((a,b)=>a.start-b.start||a.end-b.end); }
  function hasAnyGroupCompletion(){ if(GameState.tableRow.length<3)return true; return GameState.hand.some(card=>Array.from({length:GameState.tableRow.length+1},(_,i)=>i).some(index=>chooseGroups(groupsForPlacement(GameState.tableRow,card,index)).length>0)); }
  function addRescueSet(){ const number=GameState.tableRow.at(-1)?.number||1; const rescue=Array.from({length:4},()=>{const card=makeCard();card.number=number;return card;}); GameState.hand.splice(0,rescue.length,...rescue); GameState.rescuesUsed+=1; return number; }
  const GameEngine = { placeCard(cardId,index){ if(GameState.phase!=='PLAYING')return {ok:false}; const handIndex=GameState.hand.findIndex(c=>c.id===cardId); if(handIndex<0||!Number.isInteger(index)||index<0||index>GameState.tableRow.length)return {ok:false}; GameState.moves+=1; const card=GameState.hand[handIndex]; GameState.hand.splice(handIndex,1); GameState.tableRow.splice(index,0,card); const groups=chooseGroups(candidateGroups(GameState.tableRow)); for(const group of groups.slice().sort((a,b)=>b.start-a.start)){GameState.completedGroups.push({cards:group.cards.map(cloneCard),rules:[...group.rules]});GameState.tableRow.splice(group.start,group.cards.length);} if(GameState.completedGroups.length>=VICTORY_GROUPS){GameState.phase='WON';return {ok:true,completed:groups,winner:true};} GameState.hand.push(makeCard()); const rescued=!hasAnyGroupCompletion()&&GameState.tableRow.length>=7&&GameState.rescuesUsed<1; const rescueNumber=rescued?addRescueSet():null; return {ok:true,completed:groups,winner:false,loser:false,rescued,rescueNumber}; } };
  function playTone(){ if(!GameState.settings.sound)return; try{const C=window.AudioContext||window.webkitAudioContext;if(!C)return;const ac=new C(),o=ac.createOscillator(),g=ac.createGain();o.type='sine';o.frequency.value=205;g.gain.setValueAtTime(.0001,ac.currentTime);g.gain.exponentialRampToValueAtTime(.045,ac.currentTime+.012);g.gain.exponentialRampToValueAtTime(.0001,ac.currentTime+.16);o.connect(g).connect(ac.destination);o.start();o.stop(ac.currentTime+.17);}catch{} }

  function resize(){ const w=innerWidth,h=innerHeight; const narrow=w<600; const compact=h<620; const landscape=w>h&&h<700; renderer.setSize(w,h,false);camera.aspect=w/h;camera.fov=landscape?46:narrow?43:w<1000?41:39;camera.position.set(0,landscape?8.2:narrow?10.1:w<1000?9.6:9.2,landscape?13.8:narrow?12.8:w<1000?11.8:11.4);camera.lookAt(0,landscape?.15:narrow?.3:.3,landscape?-1.1:narrow?-.45:-.8); }
  addEventListener('resize',resize); resize();
  function render(){requestAnimationFrame(render); if(!drag&&GameState.phase==='PLAYING'){const t=performance.now()*.00035; farRail.position.y=-.06+Math.sin(t)*.002;} renderer.render(scene,camera);} render();

  const homeSheet=document.getElementById('homeSheet'),featuresSheet=document.getElementById('featuresSheet'),pauseSheet=document.getElementById('pauseSheet'),settingsSheet=document.getElementById('settingsSheet'),resumeSheet=document.getElementById('resumeSheet'),rulesSheet=document.getElementById('rulesSheet');
  const introSheet=document.getElementById('introSheet'),resultSheet=document.getElementById('resultSheet'),contextHint=document.getElementById('contextHint'),raceHandoffSheet=document.getElementById('raceHandoffSheet'),raceHud=document.getElementById('raceHud'),raceTimer=document.getElementById('raceTimer'),racePlayerLabel=document.getElementById('racePlayerLabel'),onlineSheet=document.getElementById('onlineSheet'),onlineStatus=document.getElementById('onlineStatus'),onlineRoomCodeEl=document.getElementById('onlineRoomCode'),onlineConfigNote=document.getElementById('onlineConfigNote');
  let hintTimer=0;
  function showContextHint(text,duration=3200){clearTimeout(hintTimer);contextHint.textContent=text;contextHint.hidden=false;hintTimer=setTimeout(()=>{contextHint.hidden=true;},duration);}
  function showStateHint(){if(GameState.phase!=='PLAYING')return;if(GameState.tableRow.length===0)showContextHint('從手牌拿一張牌到桌面');else if(GameState.tableRow.length<3)showContextHint('先放滿三張牌，建立桌面牌列');else showContextHint('把牌接成連號，或把四張同數字排在一起');}
  setInterval(updateRaceHud,250);
  function formatRaceTime(ms){const total=Math.max(0,Math.floor(ms/1000));return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;}
  function updateRaceHud(){const active=(GameState.mode==='RACE'||GameState.mode==='ONLINE')&&GameState.phase==='PLAYING'&&homeSheet.hidden&&featuresSheet.hidden&&rulesSheet.hidden&&onlineSheet.hidden;raceHud.hidden=!active;if(!active)return;racePlayerLabel.textContent=GameState.mode==='ONLINE'?`玩家 ${GameState.racePlayer} · 線上`:`玩家 ${GameState.racePlayer}`;raceTimer.textContent=formatRaceTime(Date.now()-(GameState.raceStartedAt||Date.now()));}
  function setOnlineStatus(text){onlineStatus.textContent=text;}
  function saveOnlineSession(code, token) {
    try {
      if (code && token) localStorage.setItem('solo_online_session', JSON.stringify({ code, token }));
      else localStorage.removeItem('solo_online_session');
    } catch {}
  }
  function getSavedOnlineSession() {
    try {
      const raw = localStorage.getItem('solo_online_session');
      if (raw) return JSON.parse(raw);
    } catch {}
    return null;
  }
  function showOnlineRoomInfo(code) {
    onlineRoomCode = code;
    onlineRoomCodeEl.textContent = code;
    onlineRoomCodeEl.hidden = false;
    const inviteUrl = `${location.origin}${location.pathname}?join=${code}`;
    const inviteUrlInput = document.getElementById('onlineInviteUrlInput');
    const inviteUrlRow = document.getElementById('onlineInviteUrlRow');
    if (inviteUrlInput && inviteUrlRow) {
      inviteUrlInput.value = inviteUrl;
      inviteUrlRow.hidden = false;
    }
    saveOnlineSession(code, onlineToken);
    setOnlineStatus(`房間代碼 ${code} 已建立！將邀請連結傳給對手即可加入。`);
  }
  function sendOnline(message){
    const wsUrl = getOnlineWsUrl();
    if(!wsUrl){ setOnlineStatus('無法取得伺服器位址'); return false; }
    if(onlineSocket?.readyState===WebSocket.OPEN){
      onlineSocket.send(JSON.stringify(message));
      return true;
    }
    onlinePending=message;
    connectOnline();
    return false;
  }
  function connectOnline(){
    const wsUrl = getOnlineWsUrl();
    if(!wsUrl){onlineConfigNote.textContent='尚未設定 WebSocket 伺服器。請在 config.js 填入 wss:// 位址；GitHub Pages 仍可使用本機模式。';onlineConfigNote.hidden=false;return;}
    onlineConfigNote.hidden=true;
    if(onlineSocket&&(onlineSocket.readyState===WebSocket.OPEN||onlineSocket.readyState===WebSocket.CONNECTING))return;
    setOnlineStatus('正在連接線上桌面…'); onlineSocket=new WebSocket(wsUrl);
    onlineSocket.onopen=()=>{
      setOnlineStatus('已連線，正在等待房間操作。');
      const saved = getSavedOnlineSession();
      if(!onlineToken && saved) { onlineToken = saved.token; onlineRoomCode = saved.code; }
      if(onlineToken && onlineRoomCode) onlineSocket.send(JSON.stringify({type:'RECONNECT',code:onlineRoomCode,token:onlineToken}));
      else if(onlinePending){ onlineSocket.send(JSON.stringify(onlinePending)); onlinePending=null; }
    };
    onlineSocket.onmessage=e=>{let msg;try{msg=JSON.parse(e.data);}catch{return;}handleOnlineMessage(msg);};
    onlineSocket.onerror=()=>setOnlineStatus('無法連接線上伺服器。');
    onlineSocket.onclose=()=>{
      onlineSocket=null;
      if(onlineRoomCode&&onlineToken){
        setOnlineStatus('連線中斷，正在嘗試重新連線…');
        clearTimeout(onlineReconnectTimer);
        onlineReconnectTimer=setTimeout(connectOnline,1800);
      }else setOnlineStatus('線上伺服器目前未連接。');
    };
  }
  function applyOnlineState(msg){
    const game=msg.game||{}; GameState.mode='ONLINE';GameState.racePlayer=msg.player||1;GameState.hand=(game.hand||[]).map(cloneCard);GameState.tableRow=(game.tableRow||[]).map(cloneCard);GameState.completedGroups=(game.completedGroups||[]).map(g=>({cards:g.cards.map(cloneCard),rules:[...g.rules]}));GameState.moves=game.moves||0;GameState.raceStartedAt=Date.now()-(game.elapsedMs||0);GameState.phase=game.finished?'PAUSED':msg.room?.status==='PLAYING'?'PLAYING':'PAUSED';syncMeshes();
    if(msg.room?.roomCode) showOnlineRoomInfo(msg.room.roomCode);
    homeSheet.hidden=true;pauseSheet.hidden=true;resumeSheet.hidden=true;onlineSheet.hidden=msg.room?.status==='PLAYING';busy=GameState.phase!=='PLAYING';setDock('table');updateRaceHud();
    if(msg.room?.status==='WAITING')setOnlineStatus(`房間 ${onlineRoomCode} 已建立，等待另一位玩家加入。`);else if(game.finished)setOnlineStatus('你已完成，等待另一位玩家。');else setOnlineStatus('線上牌局進行中。');
  }
  function showOnlineMatchResult(results,winner){
    GameState.mode='ONLINE';GameState.phase='WON';busy=true;const ordered=[...(results||[])].sort((a,b)=>a.elapsedMs-b.elapsedMs);resultSheet.classList.add('victory-result');document.body.classList.add('victory-state');document.getElementById('resultEyebrow').textContent='ONLINE RACE COMPLETE';document.getElementById('resultTitle').textContent=`玩家 ${winner} 勝出`;document.getElementById('resultNote').textContent=ordered.map(r=>`玩家 ${r.player} ${formatRaceTime(r.elapsedMs)}`).join(' · ');document.getElementById('resultGroups').textContent=String(VICTORY_GROUPS).padStart(2,'0');document.getElementById('resultMoves').textContent=String(GameState.moves||0).padStart(2,'0');document.getElementById('resultTypes').textContent='LIVE';resultSheet.hidden=false;onlineSheet.hidden=true;updateRaceHud();}
  function handleOnlineMessage(msg){
    if(msg.type==='CONNECTED'){
      onlineToken=msg.token||onlineToken; onlineRoomCode=msg.room?.roomCode||onlineRoomCode;
      saveOnlineSession(onlineRoomCode, onlineToken);
      if(msg.room?.status==='WAITING') showOnlineRoomInfo(onlineRoomCode);
      return;
    }
    if(msg.type==='ROOM_CREATED'){
      showOnlineRoomInfo(msg.code);
      return;
    }
    if(msg.type==='STATE'){applyOnlineState(msg);return;}
    if(msg.type==='MATCH_STARTED'){onlineSheet.hidden=true;setOnlineStatus('兩位玩家已就緒，開始計時。');updateRaceHud();return;}
    if(msg.type==='PLAYER_FINISHED'){setOnlineStatus(`玩家 ${msg.player} 已完成，等待另一位玩家。`);return;}
    if(msg.type==='MATCH_RESULT'){showOnlineMatchResult(msg.results,msg.winner);saveOnlineSession('','');return;}
    if(msg.type==='RESCUE_SET'){showContextHint(`已補入四張 ${msg.number}，把它們排在一起即可完成`);return;}
    if(msg.type==='PLAYER_DISCONNECTED'){setOnlineStatus('另一位玩家已離線，等待重新連線。');return;}
    if(msg.type==='ERROR'){
      if(msg.code==='RECONNECT_FAILED'||msg.code==='ROOM_NOT_FOUND'){saveOnlineSession('','');onlineRoomCode='';}
      setOnlineStatus(msg.message||'線上操作失敗。');busy=false;
    }
  }
  function checkInviteUrlOnLoad(){
    const params=new URLSearchParams(location.search);
    const joinCode=params.get('join')||params.get('room');
    if(joinCode){
      const code=joinCode.trim().toUpperCase();
      history.replaceState(null,'',location.pathname+location.hash);
      openOnline();
      document.getElementById('onlineRoomInput').value=code;
      setOnlineStatus(`正在加入房間 ${code}…`);
      busy=true;
      sendOnline({type:'JOIN_ROOM',code});
      return true;
    }
    return false;
  }
  function openOnline(){
    onlineSheet.hidden=false;homeSheet.hidden=true;busy=true;
    const wsUrl = getOnlineWsUrl();
    onlineConfigNote.hidden=Boolean(wsUrl);
    if(!wsUrl) setOnlineStatus('尚未設定 WebSocket 伺服器。');
    else connectOnline();
    updateRaceHud();
  }
  function showResult(kind){
    if(GameState.mode==='RACE'&&kind==='WON'){
      const result={player:GameState.racePlayer,time:Math.max(0,Date.now()-(GameState.raceStartedAt||Date.now())),moves:GameState.moves||0};
      GameState.raceResults=[...(GameState.raceResults||[]).filter(item=>item.player!==result.player),result];
      if(GameState.racePlayer===1){GameState.phase='PAUSED';busy=true;raceHandoffSheet.hidden=false;document.getElementById('raceHandoffTitle').textContent='玩家 1 完成';document.getElementById('raceHandoffNote').textContent=`用時 ${formatRaceTime(result.time)}。請把裝置交給玩家 2。`;document.getElementById('nextRacePlayerButton').textContent='玩家 2 開始';updateRaceHud();save();return;}
    }
    GameState.phase=kind==='WON'?'WON':'LOST'; busy=true; const won=kind==='WON'; const raceFinished=won&&GameState.mode==='RACE'&&GameState.raceResults.length>=2; resultSheet.classList.toggle('victory-result',won); document.body.classList.toggle('victory-state',won); document.getElementById('resultEyebrow').textContent=raceFinished?'RACE COMPLETE':won?'TABLE COMPLETE':'THE TABLE IS QUIET'; if(raceFinished){const ordered=[...GameState.raceResults].sort((a,b)=>a.time-b.time);document.getElementById('resultTitle').textContent=`玩家 ${ordered[0].player} 勝出`;document.getElementById('resultNote').textContent=`玩家 1 ${formatRaceTime(GameState.raceResults.find(item=>item.player===1).time)} · 玩家 2 ${formatRaceTime(GameState.raceResults.find(item=>item.player===2).time)}`;}else{document.getElementById('resultTitle').textContent=won?'桌面完成':'桌面暫時沒有下一步';document.getElementById('resultNote').textContent=won?'四組牌面已經在桌上留下完整結構。':'你可以保留這張桌面，或重新開始。';} document.getElementById('resultGroups').textContent=String(GameState.completedGroups.length).padStart(2,'0'); document.getElementById('resultMoves').textContent=raceFinished?String(GameState.raceResults.reduce((sum,item)=>sum+item.moves,0)).padStart(2,'0'):String(GameState.moves||0).padStart(2,'0'); document.getElementById('resultTypes').textContent=raceFinished?`P${[...GameState.raceResults].sort((a,b)=>a.time-b.time)[0].player}`:new Set(GameState.completedGroups.flatMap(g=>g.rules.includes('same-number-set')?'同點數':'連號')).size; resultSheet.hidden=false;raceHandoffSheet.hidden=true;updateRaceHud();save(); }
  function closeResult(){resultSheet.hidden=true;busy=false;document.body.classList.remove('victory-state');updateRaceHud();}
  function closeOverlays(){homeSheet.hidden=true;featuresSheet.hidden=true;rulesSheet.hidden=true;pauseSheet.hidden=true;settingsSheet.hidden=true;resumeSheet.hidden=true;resultSheet.hidden=true;raceHandoffSheet.hidden=true;onlineSheet.hidden=true;}
  function startNewGame(){GameState.mode='SOLO';GameState.racePlayer=1;GameState.raceResults=[];initialState();GameState.settings.seenIntro=true;syncMeshes();save();closeOverlays();busy=false;feedback('新的一局開始');showStateHint();updateRaceHud();setDock('table');}
  function startRace(){GameState.mode='RACE';GameState.racePlayer=1;GameState.raceResults=[];initialState();GameState.settings.seenIntro=true;syncMeshes();save();closeOverlays();busy=false;feedback('雙人競速開始，玩家 1');updateRaceHud();setDock('table');showContextHint('玩家 1 開始計時，完成四組牌面');}
  function nextRacePlayer(){GameState.racePlayer=2;initialState();syncMeshes();raceHandoffSheet.hidden=true;busy=false;save();updateRaceHud();setDock('table');feedback('玩家 2 開始計時');showContextHint('玩家 2 開始計時，完成四組牌面');}
  function continueGame(){GameState.settings.seenIntro=true;homeSheet.hidden=true;busy=false;showStateHint();feedback('回到桌面');updateRaceHud();}
  function goHome(){if(GameState.phase==='PAUSED')GameState.phase='PLAYING';document.getElementById('homeContinueButton').hidden=!(GameState.tableRow.length>0||GameState.completedGroups.length>0||GameState.mode==='ONLINE');pauseSheet.hidden=true;onlineSheet.hidden=true;homeSheet.hidden=false;busy=true;save();updateRaceHud();}
  function setDock(view){document.querySelectorAll('.dock-item').forEach(item=>item.classList.toggle('active',item.dataset.view===view));}
  function openDockView(view){
    featuresSheet.hidden=true;rulesSheet.hidden=true;onlineSheet.hidden=true;homeSheet.hidden=true;
    if(view==='home'){goHome();setDock('home');return;}
    if(view==='table'){if(GameState.phase==='PAUSED'){pauseSheet.hidden=false;busy=true;}else{pauseSheet.hidden=true;busy=false;showStateHint();}setDock('table');return;}
    if(view==='features'){featuresSheet.hidden=false;busy=true;setDock('features');return;}
    if(view==='rules'){rulesSheet.hidden=false;busy=true;setDock('rules');}
  }
  function restart(){if(GameState.mode==='ONLINE'){startNewGame();return;}initialState();syncMeshes();save();pauseSheet.hidden=true;settingsSheet.hidden=true;resumeSheet.hidden=true;closeResult();feedback('新的一局開始');showStateHint();}
  document.getElementById('startGameButton').onclick=()=>{if(GameState.phase==='WON'||GameState.phase==='LOST')initialState();GameState.settings.seenIntro=true;introSheet.hidden=true;busy=false;GameState.phase='PLAYING';syncMeshes();save();showStateHint();};
  document.getElementById('continueSavedButton').onclick=()=>{resumeSheet.hidden=true;busy=false;showStateHint();feedback('已回到原本的桌面');};
  document.getElementById('newSavedGameButton').onclick=restart;
  document.getElementById('homeStartButton').onclick=startNewGame;
  document.getElementById('homeRaceButton').onclick=startRace;
  document.getElementById('homeOnlineButton').onclick=openOnline;
  document.getElementById('homeContinueButton').onclick=continueGame;
  document.getElementById('nextRacePlayerButton').onclick=nextRacePlayer;
  document.getElementById('cancelRaceButton').onclick=startNewGame;
  document.getElementById('homeFeaturesButton').onclick=()=>{homeSheet.hidden=true;featuresSheet.hidden=false;};
  document.getElementById('homeRulesButton').onclick=()=>{homeSheet.hidden=true;rulesSheet.hidden=false;};
  document.getElementById('closeFeaturesButton').onclick=()=>{featuresSheet.hidden=true;homeSheet.hidden=false;};
  document.getElementById('createOnlineRoomButton').onclick=()=>{if(!getOnlineWsUrl()){openOnline();setOnlineStatus('尚未設定 WebSocket 伺服器。請在 config.js 填入 wss:// 位址。');return;}busy=true;sendOnline({type:'CREATE_ROOM'});};
  document.getElementById('joinOnlineRoomButton').onclick=()=>{const code=document.getElementById('onlineRoomInput').value.trim().toUpperCase();if(!code){setOnlineStatus('請先輸入房間代碼。');return;}if(!getOnlineWsUrl()){openOnline();setOnlineStatus('尚未設定 WebSocket 伺服器。請在 config.js 填入 wss:// 位址。');return;}busy=true;sendOnline({type:'JOIN_ROOM',code});};
  const copyBtn = document.getElementById('copyInviteUrlButton');
  if (copyBtn) {
    copyBtn.onclick = () => {
      const input = document.getElementById('onlineInviteUrlInput');
      if (input && input.value) {
        navigator.clipboard.writeText(input.value).then(() => {
          copyBtn.textContent = '已複製連結！';
          setTimeout(() => { copyBtn.textContent = '複製連結'; }, 2000);
        }).catch(() => {
          input.select();
          document.execCommand('copy');
          copyBtn.textContent = '已複製連結！';
          setTimeout(() => { copyBtn.textContent = '複製連結'; }, 2000);
        });
      }
    };
  }
  document.getElementById('closeOnlineButton').onclick=()=>{onlineSheet.hidden=true;homeSheet.hidden=false;busy=true;setDock('home');updateRaceHud();};
  document.querySelectorAll('.dock-item').forEach(item=>item.addEventListener('click',()=>openDockView(item.dataset.view)));
  document.getElementById('pauseButton').onclick=()=>{if(GameState.phase!=='PLAYING')return;GameState.phase='PAUSED';pauseSheet.hidden=false;busy=true;save();setDock('table');}; document.getElementById('resumeButton').onclick=()=>{if(GameState.phase==='PAUSED')GameState.phase='PLAYING';pauseSheet.hidden=true;busy=false;save();setDock('table');}; document.getElementById('restartButton').onclick=restart; document.getElementById('settingsButton').onclick=()=>{pauseSheet.hidden=true;settingsSheet.hidden=false;}; document.getElementById('rulesButton').onclick=()=>{pauseSheet.hidden=true;rulesSheet.hidden=false;busy=true;setDock('rules');}; document.getElementById('homeButton').onclick=()=>{goHome();setDock('home');}; document.getElementById('closeRulesButton').onclick=()=>{rulesSheet.hidden=true;if(GameState.phase==='PAUSED'){pauseSheet.hidden=false;busy=true;setDock('table');}else{homeSheet.hidden=false;busy=true;setDock('home');}}; document.getElementById('exitButton').onclick=()=>{save();if(history.length>1)history.back();else{pauseSheet.hidden=true;busy=false;}}; document.getElementById('closeSettingsButton').onclick=()=>{settingsSheet.hidden=true;pauseSheet.hidden=false;}; document.getElementById('viewTableButton').onclick=closeResult; document.getElementById('newGameButton').onclick=()=>{if(GameState.mode==='RACE')startRace();else if(GameState.mode==='ONLINE')startNewGame();else restart();};
  const settingIds={sound:'soundToggle',haptics:'hapticsToggle',reduceMotion:'motionToggle',highContrast:'contrastToggle'};
  Object.keys(settingIds).forEach(k=>{const el=document.getElementById(settingIds[k]);el.addEventListener('change',async()=>{GameState.settings[k]=el.checked; if(k==='highContrast')cardMeshes.forEach((_,id)=>removeMesh(id));syncMeshes();await save();});});
  restore().then(()=>{Object.keys(settingIds).forEach(k=>{const el=document.getElementById(settingIds[k]);if(el)el.checked=!!GameState.settings[k];});syncMeshes();introSheet.hidden=true;featuresSheet.hidden=true;rulesSheet.hidden=true;pauseSheet.hidden=true;settingsSheet.hidden=true;resumeSheet.hidden=true;resultSheet.hidden=true;onlineSheet.hidden=true;if(GameState.phase==='PAUSED'){homeSheet.hidden=true;pauseSheet.hidden=false;busy=true;setDock('table');}else if(GameState.phase==='WON'||GameState.phase==='LOST'){homeSheet.hidden=true;showResult(GameState.phase);setDock('table');}else{const hasSave=GameState.tableRow.length>0||GameState.completedGroups.length>0||GameState.mode==='RACE'||GameState.mode==='ONLINE';document.getElementById('homeContinueButton').hidden=!hasSave;homeSheet.hidden=false;busy=true;setDock('home');}updateRaceHud();checkInviteUrlOnLoad();}).catch(()=>{initialState();syncMeshes();introSheet.hidden=true;featuresSheet.hidden=true;rulesSheet.hidden=true;pauseSheet.hidden=true;settingsSheet.hidden=true;resumeSheet.hidden=true;resultSheet.hidden=true;onlineSheet.hidden=true;document.getElementById('homeContinueButton').hidden=true;homeSheet.hidden=false;busy=true;setDock('home');updateRaceHud();checkInviteUrlOnLoad();});
  addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')save();});
  addEventListener('pagehide',()=>save());
})();
