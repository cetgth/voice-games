"use strict";

// ===================== 튜닝 상수 =====================
const CFG = {
  rmsGate: 0.012,     // 이보다 작은 소리는 무시 (마이크가 너무 예민하면 올리세요)
  voiceHold: 0.25,    // 소리가 잠깐 끊겨도 이 시간(초)만큼은 유지로 간주
  smoothing: 0.35,    // 피치→높이 스무딩 (0~1, 클수록 즉각 반응)
  startSpeed: 240, maxSpeed: 560, speedStep: 6,
  spawnStart: 1.0, spawnMin: 0.75,  // 장애물(음) 간격(초) — 1초로 시작해 0.75초까지 좁혀짐
  gapStart: 210, gapMin: 140,       // 통과 구멍 크기(px)
  duckZone: 0.22,     // 음역 하위 이 비율까지는 낮은 음 = 웅크리기
  rangeUse: 0.78,     // 캘리브레이션 음역 중 실제 사용 비율(로그 기준) — 최고음까지 안 짜내도 천장에 닿게
  harmonyCents: 40,   // 화음 판정 허용 오차(센트, 반음=100)
  harmonyFill: 30, harmonyDrain: 14, // 하모니 게이지 초당 증감
};

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, stars = [];
function resize(){
  W = canvas.width = innerWidth; H = canvas.height = innerHeight;
  stars = [];
  for(let i=0;i<70;i++) stars.push({x:Math.random()*W, y:Math.random()*H*0.9, r:Math.random()*1.6+0.4, ph:Math.random()*6.28});
}
addEventListener('resize', resize); resize();

const $ = id => document.getElementById(id);
const clamp = (v,a,b)=>v<a?a:v>b?b:v;
const NOTE_KR = ['도','도#','레','레#','미','파','파#','솔','솔#','라','라#','시'];
function noteName(f){
  if(!(f>0)) return '—';
  const m = Math.round(69 + 12*Math.log2(f/440));
  return NOTE_KR[((m%12)+12)%12] + (Math.floor(m/12)-1);
}
function median(arr){ const a=[...arr].sort((x,y)=>x-y); return a[Math.floor(a.length/2)]; }

// ===================== 오디오 / 피치 검출 =====================
const audio = { ctx:null, source:null, calibAnalyser:null, bandNodes:[], ready:false,
                buf:new Float32Array(2048), corr:new Float32Array(1300) };

async function initAudio(){
  if(audio.ready) return true;
  try{
    const stream = await navigator.mediaDevices.getUserMedia({
      audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false }
    });
    const ac = new (window.AudioContext||window.webkitAudioContext)();
    await ac.resume();
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser(); an.fftSize = 2048;
    src.connect(an);
    audio.ctx=ac; audio.source=src; audio.calibAnalyser=an; audio.ready=true;
    return true;
  }catch(err){
    alert('마이크를 사용할 수 없어요 ('+err.name+')\n마우스 드래그로는 플레이할 수 있습니다.');
    return false;
  }
}

// 듀엣용: 저역/고역 필터 체인 끝에 분석기를 단다 (12dB x2 롤오프)
function makeChain(type, freq){
  const f1 = audio.ctx.createBiquadFilter(); f1.type=type; f1.frequency.value=freq; f1.Q.value=0.7;
  const f2 = audio.ctx.createBiquadFilter(); f2.type=type; f2.frequency.value=freq; f2.Q.value=0.7;
  const an = audio.ctx.createAnalyser(); an.fftSize=2048;
  audio.source.connect(f1); f1.connect(f2); f2.connect(an);
  audio.bandNodes.push(f1);
  return an;
}

// 정규화 자기상관(ACF) 피치 검출. minF~maxF 범위만 탐색해서
// 다른 대역의 목소리(하모닉 누설)를 걸러낸다.
function detectPitch(analyser, minF, maxF){
  analyser.getFloatTimeDomainData(audio.buf);
  const buf = audio.buf, sr = audio.ctx.sampleRate, WIN = 1024;
  let rms = 0;
  for(let i=0;i<WIN;i++) rms += buf[i]*buf[i];
  rms = Math.sqrt(rms/WIN);
  if(rms < CFG.rmsGate) return {freq:-1, rms};
  const minLag = Math.max(2, Math.floor(sr/maxF));
  const maxLag = Math.min(Math.floor(sr/minF), buf.length-WIN-1, audio.corr.length-2);
  if(minLag >= maxLag) return {freq:-1, rms};
  let e0 = 0;
  for(let i=0;i<WIN;i++) e0 += buf[i]*buf[i];
  const corr = audio.corr;
  let gmax = 0;
  for(let lag=minLag; lag<=maxLag; lag++){
    let sum=0, el=0;
    for(let i=0;i<WIN;i++){ const b=buf[i+lag]; sum += buf[i]*b; el += b*b; }
    const c = sum/Math.sqrt(e0*el + 1e-9);
    corr[lag] = c;
    if(c > gmax) gmax = c;
  }
  if(gmax < 0.5) return {freq:-1, rms};
  // 옥타브 오검출 방지: 전역 최대의 93% 이상인 가장 이른(=높은 음) 봉우리 선택
  let lag = -1;
  for(let l=minLag+1; l<maxLag; l++){
    if(corr[l] >= 0.93*gmax && corr[l] >= corr[l-1] && corr[l] >= corr[l+1]){ lag=l; break; }
  }
  if(lag < 0) return {freq:-1, rms};
  const x1=corr[lag-1], x2=corr[lag], x3=corr[lag+1];
  const a=(x1+x3-2*x2)/2, b=(x3-x1)/2;
  let T = lag;
  if(Math.abs(a) > 1e-9) T = lag - b/(2*a);
  return {freq: sr/T, rms};
}

// ===================== 보이스 상태 =====================
function makeVoice(){ return {freq:-1, rms:0, norm:0, active:false, lastVoiced:-1e9, smooth:-1}; }
function updateVoice(v, det, lo, hi, now){
  v.rms = det.rms || 0;
  if(det.freq > 0){
    v.freq = det.freq; v.lastVoiced = now;
    const n = clamp(Math.log(det.freq/lo)/Math.log(hi/lo), 0, 1);
    v.smooth = v.smooth < 0 ? n : v.smooth + (n-v.smooth)*CFG.smoothing;
    v.norm = v.smooth;
  }
  v.active = (now - v.lastVoiced) < CFG.voiceHold;
  if(!v.active){ v.freq = -1; v.smooth = -1; }
}

// 화음 판정: 두 주파수를 옥타브 안으로 접어서 순정률 협화음정과 비교
function consonant(f1, f2){
  if(!(f1>0) || !(f2>0)) return false;
  let r = f2/f1; if(r < 1) r = 1/r;
  while(r >= 2) r /= 2;
  const targets = [1, 6/5, 5/4, 4/3, 3/2, 5/3];
  for(const t of targets){
    if(Math.abs(1200*Math.log2(r/t)) < CFG.harmonyCents) return true;
  }
  return false;
}

// ===================== 게임 상태 =====================
let state='menu', mode='solo', players=[], world=null, calib=null, tNow=0;
const overrides=[null,null];        // 마우스 치트
const pointerIds = new Map();

function buildPlayers(){
  players = mode==='solo'
    ? [{name:'', emoji:chosen[0], lo:110, hi:520, hue:45}]
    : [{name:getName(0)+' · 저음', emoji:chosen[0], lo:100, hi:240, hue:25},
       {name:getName(1)+' · 고음', emoji:chosen[1], lo:280, hi:800, hue:190}];
  for(const p of players){
    p.voice=makeVoice(); p.y=0; p.prevY=0; p.duck=false; p.r=16;
    p.det=[55,1500]; p.analyser=null; p.ctrlActive=false; p.ctrlNorm=0; p.x=0; p.stuck=false;
  }
}

function lanes(){
  return mode==='solo'
    ? [{top:46, bottom:H-46}]
    : [{top:H/2+36, bottom:H-42}, {top:46, bottom:H/2-36}];
}

// ===================== 캘리브레이션 =====================
function startCalib(){
  const steps = [];
  if(mode==='solo'){
    steps.push({p:0,k:'lo',t:'낮은 음 측정',d:'편하게 낼 수 있는 <b>가장 낮은 음</b>을 "음~" 하고 유지해 주세요'});
    steps.push({p:0,k:'hi',t:'높은 음 측정',d:'편하게 낼 수 있는 <b>가장 높은 음</b>을 유지해 주세요'});
  }else{
    const n0 = getName(0), n1 = getName(1), e0 = esc(n0), e1 = esc(n1);
    steps.push({p:0,k:'lo',t:n0+' '+chosen[0]+' 저음 담당 · 낮은 음',d:e0+'가 편한 <b>가장 낮은 음</b>을 유지해 주세요 ('+e1+'는 조용히!)'});
    steps.push({p:0,k:'hi',t:n0+' '+chosen[0]+' 저음 담당 · 높은 음',d:e0+'가 편한 <b>가장 높은 음</b>을 유지해 주세요'});
    steps.push({p:1,k:'lo',t:n1+' '+chosen[1]+' 고음 담당 · 낮은 음',d:e1+'가 편한 <b>가장 낮은 음</b>을 유지해 주세요 ('+e0+'는 조용히!)'});
    steps.push({p:1,k:'hi',t:n1+' '+chosen[1]+' 고음 담당 · 높은 음',d:e1+'의 <b>가장 높은 음</b>! 마음껏 올려보세요'});
  }
  calib = {steps, i:0, samples:[], need:45, cooldown:0};
  $('calib').classList.remove('hidden');
  $('btnHome').classList.remove('hidden');
  showCalibStep();
  state = 'calib';
}
function showCalibStep(){
  const s = calib.steps[calib.i];
  $('calibTitle').textContent = s.t;
  $('calibDesc').innerHTML = s.d;
  $('calibNote').textContent = '—';
  $('calibBar').style.width = '0%';
}
function calibFrame(dt){
  if(calib.cooldown > 0){
    calib.cooldown -= dt;
    if(calib.cooldown <= 0){
      calib.i++;
      if(calib.i >= calib.steps.length){ finalizeCalib(); startRun(); return; }
      calib.samples = []; showCalibStep();
    }
    return;
  }
  const det = detectPitch(audio.calibAnalyser, 55, 1500);
  if(det.freq > 0){
    calib.samples.push(det.freq);
    $('calibNote').textContent = noteName(det.freq)+'  ('+Math.round(det.freq)+'Hz)';
  }
  $('calibBar').style.width = (100*calib.samples.length/calib.need)+'%';
  if(calib.samples.length >= calib.need){
    const s = calib.steps[calib.i];
    players[s.p][s.k] = median(calib.samples);
    $('calibNote').textContent = '✓ '+noteName(players[s.p][s.k]);
    calib.cooldown = 0.8;
  }
}
function finalizeCalib(){
  for(const p of players){
    if(p.hi < p.lo){ const t=p.lo; p.lo=p.hi; p.hi=t; }
    p.hi = p.lo * Math.pow(p.hi/p.lo, CFG.rangeUse);  // 상단은 잘라서 사용 — 무리해서 안 올려도 됨
    if(p.hi < p.lo*1.25) p.hi = p.lo*1.25;  // 음역이 너무 좁으면 강제로 벌림
  }
  if(mode==='solo'){
    const p = players[0];
    p.analyser = audio.calibAnalyser;
    p.det = [Math.max(55, p.lo*0.6), Math.min(1500, p.hi*1.6)];
  }else{
    let split = Math.sqrt(players[0].hi * players[1].lo);  // 두 음역 사이 기하평균
    if(!(split > players[0].lo*1.05)) split = players[0].hi*1.2;
    for(const n of audio.bandNodes){ try{ audio.source.disconnect(n); }catch(e){} }
    audio.bandNodes = [];
    players[0].analyser = makeChain('lowpass', split);
    players[1].analyser = makeChain('highpass', split);
    players[0].det = [55, split*1.12];
    players[1].det = [split*0.88, 1500];
  }
}

// ===================== 런 시작 / 종료 =====================
function startRun(){
  $('calib').classList.add('hidden');
  $('btnHome').classList.remove('hidden');
  world = { obstacles:[], particles:[], score:0,
            speed:CFG.startSpeed, spawnT:1.2, spawnInterval:CFG.spawnStart,
            gapH:CFG.gapStart, harmony:0, t:0, dist:0, flash:0, throttle:0, lastGapC:[null,null] };
  const ls = lanes();
  players.forEach((p,i)=>{
    p.voice = makeVoice();
    p.y = ls[i].bottom - 24; p.prevY = p.y;
  });
  state = 'play';
}
function goMenu(){
  logScore();   // 달리던 판이 있으면 점수 기록
  state='menu';
  $('calib').classList.add('hidden');
  $('rank').classList.add('hidden');
  $('btnHome').classList.add('hidden');
  $('menu').classList.remove('hidden');
}

// ===================== 장애물 =====================
// 직전 구멍에서 최소 35% 이상 점프한 위치를 고른다 — 음이 다이나믹하게 오르내리게
function pickGapC(lane, gapH, i){
  const lo = lane.top + gapH/2 + 14, hi = lane.bottom - gapH/2 - 14;
  const span = Math.max(1, hi-lo);
  const last = world.lastGapC[i];
  let c;
  if(last == null){
    c = lo + Math.random()*span;
  }else{
    const jump = span*(0.35 + Math.random()*0.45);
    const dir = Math.random() < 0.5 ? -1 : 1;
    c = last + dir*jump;
    if(c < lo || c > hi) c = last - dir*jump;   // 벽에 막히면 반대쪽으로
    c = clamp(c, lo, hi);
  }
  world.lastGapC[i] = c;
  return c;
}
function spawnObstacles(){
  const ls = lanes();
  for(let i=0;i<players.length;i++){
    const lane = ls[i];
    const isBar = Math.random() < (mode==='solo' ? 0.3 : 0.25);
    if(isBar){
      world.obstacles.push({type:'bar', lane:i, x:W+60, w:90, passed:false});
      world.lastGapC[i] = lane.bottom - world.gapH/2 - 14;  // 숙여 지난 직후엔 위로 점프하게
    }else{
      const gapH = world.gapH;
      world.obstacles.push({type:'gap', lane:i, x:W+60, w:34, gapH,
                            gapC: pickGapC(lane, gapH, i), passed:false});
    }
  }
}
function obsRects(o){
  const lane = lanes()[o.lane];
  if(o.type === 'bar')
    return [[o.x, lane.top-6, o.w, (lane.bottom-26)-(lane.top-6)]];
  const g1 = o.gapC - o.gapH/2, g2 = o.gapC + o.gapH/2;
  return [[o.x, lane.top-6, o.w, g1-(lane.top-6)],
          [o.x, g2, o.w, (lane.bottom+6)-g2]];
}
function explodeObstacle(o){
  for(const rc of obsRects(o)){
    for(let k=0;k<10;k++){
      world.particles.push({x:rc[0]+Math.random()*rc[2], y:rc[1]+Math.random()*rc[3],
        vx:(Math.random()-0.5)*260, vy:(Math.random()-0.5)*260,
        life:0.7, max:0.7, hue:50+Math.random()*60, size:3+Math.random()*4});
    }
  }
}

// ===================== 업데이트 =====================
function update(dt){
  world.t += dt;
  world.flash = Math.max(0, world.flash - dt*1.5);
  const ls = lanes();

  // --- 보이스 입력 ---
  players.forEach((p,i)=>{
    const det = (audio.ready && p.analyser)
      ? detectPitch(p.analyser, p.det[0], p.det[1])
      : {freq:-1, rms:0};
    updateVoice(p.voice, det, p.lo, p.hi, world.t);
    const ov = overrides[i];
    p.ctrlActive = ov ? true : p.voice.active;
    p.ctrlNorm   = ov ? ov.norm : p.voice.norm;
  });

  // --- 전진 스로틀: 소리 내는 사람 수에 비례, 모두 침묵이면 정지 ---
  const singing = players.reduce((n,p)=>n+(p.ctrlActive?1:0), 0);
  world.throttle += (singing/players.length - world.throttle)*Math.min(1, dt*6);
  const spd = world.speed * world.throttle;

  // --- 플레이어 자세 ---
  players.forEach((p,i)=>{
    const lane = ls[i];
    const minY = lane.top + 22, maxY = lane.bottom - 24;
    let target, wantDuck = false;
    if(p.ctrlActive && p.ctrlNorm < CFG.duckZone){
      target = lane.bottom - 11; wantDuck = true;   // 낮은 음 = 웅크린 채 전진
    }else if(p.ctrlActive){
      const n = (p.ctrlNorm - CFG.duckZone)/(1 - CFG.duckZone);
      target = maxY - n*(maxY-minY);                // 높은 음 = 점프/비행
    }else{
      target = lane.bottom - 18;                    // 침묵 = 제자리 정지
    }
    p.prevY = p.y;
    p.y += (target - p.y) * Math.min(1, dt*7);
    p.duck = wantDuck && p.y > lane.bottom - 22;
    p.r = p.duck ? 9 : 16;
    p.x = W*0.26;

    if(p.ctrlActive && Math.random() < 0.6)
      world.particles.push({x:p.x-16, y:p.y+6, vx:-spd*0.4-40, vy:(Math.random()-0.5)*30,
        life:0.6, max:0.6, hue:p.hue + p.ctrlNorm*140, size:3.5+Math.random()*3});
  });

  // --- 장애물: 부딪히면 데미지 대신 그 자리에 걸려서 못 나아간다 ---
  let dx = spd*dt;
  players.forEach(p=>{ p.stuck = false; });
  if(spd > 0.5){
    for(const o of world.obstacles){
      const p = players[o.lane];
      for(const rc of obsRects(o)){
        if(rc[0] + rc[2] <= p.x - p.r) continue;            // 이미 지나간 조각
        const ny = clamp(p.y, rc[1], rc[1]+rc[3]);
        if(Math.abs(p.y - ny) >= p.r) continue;             // 수직으로 안 겹침
        const room = rc[0] - (p.x + p.r);                   // 닿기까지 남은 거리
        if(room < dx){ dx = Math.max(0, room); p.stuck = true; }
      }
    }
  }
  world.dist += dx;
  world.score += dx*0.03;
  for(const o of world.obstacles) o.x -= dx;

  players.forEach(p=>{
    if(p.stuck && Math.random() < 0.3)
      world.particles.push({x:p.x+p.r+3, y:p.y+(Math.random()-0.5)*18, vx:30+Math.random()*50, vy:(Math.random()-0.5)*70,
        life:0.35, max:0.35, hue:45, size:2+Math.random()*2});
  });

  world.spawnT -= dx/world.speed;
  if(world.spawnT <= 0){
    world.spawnT = world.spawnInterval;
    world.spawnInterval = Math.max(CFG.spawnMin, world.spawnInterval - 0.02);
    world.speed = Math.min(CFG.maxSpeed, world.speed + CFG.speedStep);
    world.gapH = Math.max(CFG.gapMin, world.gapH - 2);
    spawnObstacles();
  }
  for(const o of world.obstacles){
    const p = players[o.lane];
    if(!o.passed && o.x + o.w < p.x){ o.passed = true; world.score += 10; }
  }
  world.obstacles = world.obstacles.filter(o => o.x + o.w > -60);

  // --- 하모니 (듀엣) ---
  if(mode==='duet'){
    const v0 = players[0].voice, v1 = players[1].voice;
    const harmOn = v0.active && v1.active && consonant(v0.freq, v1.freq);
    if(harmOn){
      world.harmony = Math.min(100, world.harmony + CFG.harmonyFill*dt);
      world.score += 15*dt;
      if(Math.random() < 0.5){
        const a = players[0], b = players[1], tt = Math.random();
        world.particles.push({x:a.x + (Math.random()-0.5)*36, y:a.y + (b.y-a.y)*tt,
          vx:0, vy:-40, life:0.8, max:0.8, hue:50, size:2.5+Math.random()*2});
      }
      if(world.harmony >= 100){
        for(const o of world.obstacles) explodeObstacle(o);
        world.obstacles.length = 0;
        world.score += 300; world.harmony = 0; world.flash = 0.5;
      }
    }else{
      world.harmony = Math.max(0, world.harmony - CFG.harmonyDrain*dt);
    }
  }

  // --- 파티클 ---
  for(const pa of world.particles){ pa.x += pa.vx*dt; pa.y += pa.vy*dt; pa.life -= dt; }
  world.particles = world.particles.filter(pa => pa.life > 0);
}

// ===================== 렌더링 =====================
function drawBackground(dist){
  const g = ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0,'#101c3f'); g.addColorStop(1,'#2b3866');
  ctx.fillStyle = g; ctx.fillRect(0,0,W,H);
  ctx.fillStyle = '#fff';
  for(const s of stars){
    ctx.globalAlpha = 0.25 + 0.25*Math.sin(tNow*2 + s.ph);
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.29); ctx.fill();
  }
  ctx.globalAlpha = 1;
  drawHills(dist*0.25, 30, H*0.72, '#1b2a55');
  drawHills(dist*0.5,  22, H*0.84, '#243665');
}
function drawHills(off, amp, base, color){
  ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0,H);
  for(let x=0;x<=W;x+=24){
    const y = base + Math.sin((x+off)*0.008)*amp + Math.sin((x+off)*0.021)*amp*0.4;
    ctx.lineTo(x,y);
  }
  ctx.lineTo(W,H); ctx.closePath(); ctx.fill();
}

function draw(){
  drawBackground(world ? world.dist : tNow*90);
  if(!world || state==='menu' || state==='calib') return;
  const ls = lanes();

  if(mode==='duet'){
    ctx.strokeStyle = '#ffffff30'; ctx.setLineDash([10,10]);
    ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = '#ffffff22';
  players.forEach((p,i)=>{
    ctx.fillRect(0, ls[i].bottom+4, W, 4);
    if(p.name){
      ctx.globalAlpha = 0.55; ctx.fillStyle='#fff';
      ctx.font='14px sans-serif'; ctx.textAlign='left'; ctx.textBaseline='alphabetic';
      ctx.fillText(p.emoji+' '+p.name, 14, ls[i].top+18);
      ctx.globalAlpha = 1; ctx.fillStyle = '#ffffff22';
    }
  });

  // 가로 음높이 줄무늬 밴드 (한 칸 = 같은 음정 간격)
  players.forEach((p,i)=>{
    const lane = ls[i];
    const minY = lane.top+22, maxY = lane.bottom-24;
    const step = (maxY-minY)/6;
    for(let k=0;k<6;k++){
      ctx.fillStyle = k%2===0 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.035)';
      ctx.fillRect(0, maxY - step*(k+1), W, step);
    }
    ctx.fillStyle = '#ffd16614';
    ctx.fillRect(0, maxY+6, W, lane.bottom - maxY - 2);   // 웅크리기·정지 구간
    if(audio.ready){
      ctx.font='11px sans-serif'; ctx.textAlign='left'; ctx.textBaseline='middle';
      ctx.fillStyle = '#ffffff80';
      for(let k=0;k<=6;k++){
        const n = CFG.duckZone + (1-CFG.duckZone)*k/6;
        ctx.fillText(noteName(p.lo*Math.pow(p.hi/p.lo, n)), 8, maxY - step*k);
      }
    }
  });

  // 장애물
  for(const o of world.obstacles){
    for(const rc of obsRects(o)){
      if(o.type==='gap'){
        ctx.fillStyle = '#2ecc71';
        ctx.fillRect(rc[0], rc[1], rc[2], rc[3]);
        ctx.fillStyle = '#27ae60';
        ctx.fillRect(rc[0]-4, rc[1] > lanes()[o.lane].top ? rc[1] : rc[1]+rc[3]-14, rc[2]+8, 14);
      }else{
        ctx.fillStyle = '#e67e22';
        ctx.fillRect(rc[0], rc[1], rc[2], rc[3]);
        ctx.font='22px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText('🚧', rc[0]+rc[2]/2, rc[1]+rc[3]-16);
      }
    }
  }

  // 파티클
  for(const pa of world.particles){
    ctx.globalAlpha = clamp(pa.life/pa.max, 0, 1)*0.9;
    ctx.fillStyle = 'hsl('+pa.hue+',85%,65%)';
    ctx.beginPath(); ctx.arc(pa.x, pa.y, pa.size, 0, 6.29); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 플레이어
  players.forEach((p)=>{
    const rot = clamp((p.y - p.prevY)*0.06, -0.5, 0.5);
    const scale = 1 + clamp(p.voice.rms*4, 0, 0.4);
    const shake = p.stuck ? Math.sin(tNow*45)*2.5 : 0;   // 막히면 부르르
    ctx.save();
    ctx.translate(p.x + shake, p.y);
    ctx.rotate(rot);
    // 이모지가 왼쪽을 보고 있어서 진행 방향(오른쪽)을 보도록 좌우 반전
    if(p.duck) ctx.scale(-1.2*scale, 0.65*scale); else ctx.scale(-scale, scale);
    ctx.font='34px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(p.emoji, 0, 0);
    ctx.restore();
    if(p.ctrlActive && p.voice.freq > 0){
      ctx.fillStyle = '#ffd166'; ctx.font='bold 15px sans-serif';
      ctx.textAlign='center'; ctx.textBaseline='alphabetic';
      ctx.fillText(noteName(p.voice.freq), p.x, p.y-30);
    }
  });

  // HUD
  ctx.fillStyle='#fff'; ctx.font='bold 28px sans-serif';
  ctx.textAlign='center'; ctx.textBaseline='alphabetic';
  ctx.fillText(Math.floor(world.score), W/2, 40);

  if(mode==='duet'){
    const bx=W-250, by=22, bw=220, bh=16;
    ctx.fillStyle='#ffffff22'; ctx.fillRect(bx,by,bw,bh);
    const gg = ctx.createLinearGradient(bx,0,bx+bw,0);
    gg.addColorStop(0,'#4ecdc4'); gg.addColorStop(1,'#ffd166');
    ctx.fillStyle=gg; ctx.fillRect(bx,by,bw*world.harmony/100,bh);
    ctx.fillStyle='#fff'; ctx.font='13px sans-serif'; ctx.textAlign='right';
    ctx.fillText('✨ 하모니', bx-8, by+13);
  }

  // 시작 힌트
  if(world.t < 6){
    ctx.globalAlpha = clamp((6-world.t)/1.5, 0, 1)*0.8;
    ctx.fillStyle='#fff'; ctx.font='18px sans-serif'; ctx.textAlign='center';
    const hint = mode==='solo'
      ? '🎵 소리를 내는 동안만 앞으로 가요! 높은 음 = 점프 · 낮은 음 = 웅크리기(🚧) · 침묵 = 정지'
      : '🎵 둘 다 소리 내야 최고 속도! 낮은 음 = 웅크리기(🚧) · 화음을 맞추면 게이지 충전 ✨';
    ctx.fillText(hint, W/2, H-16);
    ctx.globalAlpha = 1;
  }

  if(world.flash > 0){
    ctx.globalAlpha = world.flash*0.5;
    ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H);
    ctx.globalAlpha = 1;
  }
}

// ===================== 입력 (마우스 치트) =====================
function laneIndexAt(y){ return (mode==='duet' && y < H/2) ? 1 : 0; }
function setOverride(i, y){
  const l = lanes()[i], minY = l.top+22, maxY = l.bottom-24;
  overrides[i] = {norm: clamp((maxY-y)/(maxY-minY), 0, 1)};
}
canvas.addEventListener('pointerdown', e=>{
  if(state!=='play') return;
  const i = laneIndexAt(e.clientY);
  pointerIds.set(e.pointerId, i);
  setOverride(i, e.clientY);
});
addEventListener('pointermove', e=>{
  const i = pointerIds.get(e.pointerId);
  if(i !== undefined) setOverride(i, e.clientY);
});
const endPointer = e=>{
  const i = pointerIds.get(e.pointerId);
  if(i !== undefined){ overrides[i]=null; pointerIds.delete(e.pointerId); }
};
addEventListener('pointerup', endPointer);
addEventListener('pointercancel', endPointer);
addEventListener('keydown', e=>{
  if(e.key==='Escape') goMenu();
});

// ===================== 캐릭터 선택 =====================
const ROSTER = ['🐤','🐻','🐰','🦊','🐸','🐷','🐢','👻'];
const chosen = ['🐤','🐻'];
try{
  const s = JSON.parse(localStorage.getItem('voiceRunnerChars'));
  if(Array.isArray(s)){
    if(ROSTER.includes(s[0])) chosen[0]=s[0];
    if(ROSTER.includes(s[1])) chosen[1]=s[1];
  }
}catch(e){}
function buildPicker(){
  [0,1].forEach(pi=>{
    const box = $('pick'+pi); box.innerHTML='';
    for(const em of ROSTER){
      const b = document.createElement('button');
      b.className = 'cp-btn'+(chosen[pi]===em?' sel':'');
      b.textContent = em;
      b.onclick = ()=>{
        chosen[pi] = em;
        try{ localStorage.setItem('voiceRunnerChars', JSON.stringify(chosen)); }catch(e){}
        buildPicker();
      };
      box.appendChild(b);
    }
  });
}
buildPicker();

// ===================== 이름 / 점수 기록 =====================
function getName(i){ const v = $('name'+i).value.trim(); return v || (i ? '2P' : '1P'); }
function esc(s){ return s.replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
try{
  const nm = JSON.parse(localStorage.getItem('voiceRunnerNames'));
  if(Array.isArray(nm)){ $('name0').value = nm[0]||''; $('name1').value = nm[1]||''; }
}catch(e){}
['name0','name1'].forEach(id=>{
  $(id).addEventListener('input', ()=>{
    try{ localStorage.setItem('voiceRunnerNames', JSON.stringify([$('name0').value, $('name1').value])); }catch(e){}
  });
});
function loadScores(){
  try{ const l = JSON.parse(localStorage.getItem('voiceRunnerScores')); return Array.isArray(l)?l:[]; }catch(e){ return []; }
}
function logScore(){
  if(!world || state!=='play') return;
  const s = Math.floor(world.score);
  if(s < 10) return;   // 시작하자마자 나간 판은 기록 안 함
  const list = loadScores();
  list.push({ n: mode==='solo' ? getName(0) : getName(0)+' & '+getName(1),
              m: mode, s, d: new Date().toISOString().slice(0,10) });
  list.sort((a,b)=>b.s-a.s);
  if(list.length > 100) list.length = 100;
  try{ localStorage.setItem('voiceRunnerScores', JSON.stringify(list)); }catch(e){}
}
function renderRank(){
  const box = $('rankList'); box.innerHTML='';
  const list = loadScores().slice(0,20);
  if(!list.length){
    box.innerHTML = '<p class="tip">아직 기록이 없어요 — 첫 판을 달려보세요!</p>';
    return;
  }
  list.forEach((e,i)=>{
    const row = document.createElement('div');
    row.className = 'rank-row'+(i<3?' top':'');
    row.innerHTML = '<span class="rk">'+(i+1)+'</span><span class="nm"></span>'+
      '<span class="md">'+(e.m==='duet'?'듀엣':'솔로')+'</span>'+
      '<span class="sc">'+e.s+'</span><span class="dt">'+String(e.d).slice(5)+'</span>';
    row.querySelector('.nm').textContent = e.n;   // 이름은 사용자 입력이라 textContent로
    box.appendChild(row);
  });
}

// ===================== 메뉴 =====================
async function chooseMode(m){
  mode = m; buildPlayers();
  const ok = await initAudio();
  $('menu').classList.add('hidden');
  if(ok) startCalib(); else startRun();
}
$('btnSolo').onclick = ()=>chooseMode('solo');
$('btnDuet').onclick = ()=>chooseMode('duet');
$('btnHome').onclick = ()=>goMenu();
$('btnRank').onclick = ()=>{ renderRank(); $('menu').classList.add('hidden'); $('rank').classList.remove('hidden'); };
$('btnRankClose').onclick = ()=>{ $('rank').classList.add('hidden'); $('menu').classList.remove('hidden'); };

// ===================== 메인 루프 =====================
let lastT = performance.now();
function frame(now){
  const dt = Math.min(0.05, (now-lastT)/1000);
  lastT = now; tNow += dt;
  if(state==='calib' && audio.ready) calibFrame(dt);
  if(state==='play') update(dt);
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
