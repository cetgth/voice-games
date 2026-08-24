"use strict";

// ===================== 튜닝 상수 =====================
const CFG = {
  rmsGate: 0.012,     // 이보다 작은 소리는 무시 (마이크가 너무 예민하면 올리세요)
  voiceHold: 0.25,    // 소리가 잠깐 끊겨도 이 시간(초)만큼은 유지로 간주
  smoothing: 0.35,    // 음정 스무딩 (0~1, 클수록 즉각 반응)
  levels: 5,          // 구름 층 수
  hopSemis: 2,        // 허밍 음을 이만큼(반음) 올리거나 내리면 구름 한 칸 이동 — 큰 도약은 여러 칸
  rideLife: 3.6,      // 구름 하나를 탈 수 있는 시간(초) — 다 타면 흩어져서 갈아타야 함
  startSpeed: 240, maxSpeed: 560,   // 속도는 거리에 비례해 서서히 상승
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

// 듀엣용: 저역/고역 필터 체인 끝에 분석기를 단다
function makeChain(type, freq){
  const f1 = audio.ctx.createBiquadFilter(); f1.type=type; f1.frequency.value=freq; f1.Q.value=0.7;
  const f2 = audio.ctx.createBiquadFilter(); f2.type=type; f2.frequency.value=freq; f2.Q.value=0.7;
  const an = audio.ctx.createAnalyser(); an.fftSize=2048;
  audio.source.connect(f1); f1.connect(f2); f2.connect(an);
  audio.bandNodes.push(f1);
  return an;
}

// 정규화 자기상관(ACF) 피치 검출
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

// ===================== 보이스 상태 (상대 음정 추적) =====================
function makeVoice(){ return {freq:-1, rms:0, active:false, lastVoiced:-1e9, note:0, ref:null, pend:null}; }
function updateVoice(v, det, now){
  v.rms = det.rms || 0;
  if(det.freq > 0){
    const note = 69 + 12*Math.log2(det.freq/440);   // 반음 단위 연속값
    if(!v.active || v.ref === null){
      v.note = note; v.ref = note; v.pend = null;   // 새로 소리 시작 → 기준음 설정
    }else if(Math.abs(note - v.note) > 7){
      // 옥타브 오검출 의심 — 두 프레임 연속 비슷하면 진짜 도약으로 인정
      if(v.pend !== null && Math.abs(note - v.pend) < 2){ v.note = note; v.pend = null; }
      else v.pend = note;
    }else{
      v.note += (note - v.note)*CFG.smoothing;
      v.pend = null;
    }
    v.freq = det.freq; v.lastVoiced = now;
  }
  v.active = (now - v.lastVoiced) < CFG.voiceHold;
  if(!v.active){ v.freq = -1; v.ref = null; }
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
const overrides=[null,null];
const pointerIds = new Map();

function buildPlayers(){
  players = mode==='solo'
    ? [{name:'', emoji:chosen[0], hue:45}]
    : [{name:getName(0)+' · 저음', emoji:chosen[0], hue:25},
       {name:getName(1)+' · 고음', emoji:chosen[1], hue:190}];
  for(const p of players){
    p.voice=makeVoice(); p.y=0; p.prevY=0; p.vy=0; p.landT=-9; p.settled=true; p.riding=false; p.r=16; p.level=2;
    p.det=[55,1500]; p.analyser=null; p.ctrlActive=false; p.x=0; p.airT=0; p.rideSeg=null;
  }
}

function lanes(){
  return mode==='solo'
    ? [{top:46, bottom:H-46}]
    : [{top:H/2+36, bottom:H-42}, {top:46, bottom:H/2-36}];
}
// L층 구름의 y 좌표 (0층 = 맨 아래)
function levelY(lane, L){
  const yBot = lane.bottom-28, yTop = lane.top+30;
  return yBot - (yBot-yTop)*L/(CFG.levels-1);
}
function rowHalf(lane){
  return (lane.bottom-28 - (lane.top+30))/(CFG.levels-1)/2*0.95;
}

// ===================== 캘리브레이션 (듀엣 전용: 각자 편한 음 하나) =====================
function startCalib(){
  const n0 = getName(0), n1 = getName(1), e0 = esc(n0), e1 = esc(n1);
  const steps = [
    {p:0,k:'mid',t:n0+' '+chosen[0]+' 저음 담당',d:e0+'가 편한 음을 "음~" 하고 유지해 주세요 ('+e1+'는 조용히!)'},
    {p:1,k:'mid',t:n1+' '+chosen[1]+' 고음 담당',d:e1+'가 편한 음을 유지해 주세요 — '+e0+'보다 높게! ('+e0+'는 조용히!)'},
  ];
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
  const m0 = players[0].mid, m1 = players[1].mid;
  let split = Math.sqrt(m0*m1);   // 두 사람 음 사이 기하평균으로 대역 분리
  if(!(m1 > m0*1.15)) split = m0*1.25;
  for(const n of audio.bandNodes){ try{ audio.source.disconnect(n); }catch(e){} }
  audio.bandNodes = [];
  players[0].analyser = makeChain('lowpass', split);
  players[1].analyser = makeChain('highpass', split);
  players[0].det = [55, split*1.12];
  players[1].det = [split*0.88, 1500];
}

// ===================== 런 시작 / 종료 =====================
function startRun(){
  $('calib').classList.add('hidden');
  $('btnHome').classList.remove('hidden');
  world = { terrain:[[],[]], particles:[], score:0,
            speed:CFG.startSpeed,
            harmony:0, t:0, dist:0, flash:0, throttle:0, lastLevel:[2,2] };
  const ls = lanes();
  players.forEach((p,i)=>{
    p.voice = makeVoice();
    p.level = 2; p.vy = 0; p.x = W*0.28; p.airT = 0; p.riding = true; p.rideSeg = null;
    p.y = levelY(ls[i], p.level); p.prevY = p.y;
    world.terrain[i] = [{x: p.x-90, w: 300, level:2, ridden:true}];   // 출발 구름
    ensureTerrain(i);
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

// ===================== 구름 계단 지형 =====================
function hop(p, dir){
  const nl = clamp(p.level + dir, 0, CFG.levels-1);
  if(nl === p.level) return;
  p.level = nl;
  p.vy -= 150;   // 점프 팝 — 폴짝 튀어오르는 느낌
  for(let k=0;k<8;k++)
    world.particles.push({x:p.x+(Math.random()-0.5)*24, y:p.y+14, vx:(Math.random()-0.5)*80, vy:20+Math.random()*40,
      life:0.5, max:0.5, hue:0, sat:0, lum:92, size:3+Math.random()*3});
}
// 다음 계단 층: 직전에서 1~2칸 오르내림 (1칸이 더 흔함)
function pickNextLevel(i){
  const last = world.lastLevel[i];
  const jump = Math.random() < 0.7 ? 1 : 2;
  const dir = Math.random() < 0.5 ? -1 : 1;
  let lv = last + dir*jump;
  if(lv < 0 || lv >= CFG.levels) lv = last - dir*jump;
  lv = clamp(lv, 0, CFG.levels-1);
  if(lv === last) lv = clamp(last + (last < CFG.levels/2 ? 1 : -1), 0, CFG.levels-1);
  world.lastLevel[i] = lv;
  return lv;
}
// x 지점 밑에 깔린 계단 세그먼트
function segAt(i, x){
  for(const s of world.terrain[i]) if(x >= s.x && x < s.x + s.w) return s;
  return null;
}
// 항상 [타는 구름 + 다음 구름 하나]만 활성으로 유지 — 다음 구름은 앞쪽에서 뭉게뭉게 생겨난다
function ensureTerrain(i){
  const T = world.terrain[i];
  const px = players[i] ? players[i].x : W*0.26;
  let active = T.reduce((n,s)=>n+(s.x + s.w > px - 20 ? 1 : 0), 0);
  while(active < 2){
    const last = T.length ? T[T.length-1] : null;
    const w = clamp(200 - world.dist*0.004, 120, 200) + Math.random()*70;
    const x = Math.max(px + 380 + Math.random()*220, last ? last.x + last.w + 80 : 0);
    T.push({x, w, level: pickNextLevel(i), passed:false, ridden:false, born:tNow});
    active++;
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
    updateVoice(p.voice, det, world.t);
    const ov = overrides[i];
    p.ctrlActive = ov ? true : p.voice.active;
    if(ov) p.level = ov.level;
  });

  // --- 전진 스로틀: 소리 내는 사람 수에 비례, 모두 침묵이면 정지 ---
  const singing = players.reduce((n,p)=>n+(p.ctrlActive?1:0), 0);
  world.throttle += (singing/players.length - world.throttle)*Math.min(1, dt*6);
  const spd = world.speed * world.throttle;

  // --- 음정 점프 감지 & 구름 이동 (스프링으로 폭신하게 안착) ---
  players.forEach((p,i)=>{
    const lane = ls[i];
    const v = p.voice;
    if(!overrides[i] && v.active && v.ref !== null){
      const d = v.note - v.ref;
      if(d >= CFG.hopSemis){ hop(p, 1); v.ref = v.note; }        // 음을 올리면 위 구름으로
      else if(d <= -CFG.hopSemis){ hop(p, -1); v.ref = v.note; } // 내리면 아래 구름으로
    }
    p.x = W*0.28;
    const seg = segAt(i, p.x);
    p.riding = !!(seg && seg.level === p.level);   // 발밑 구름과 높이가 맞으면 탑승 중
    if(p.riding){
      p.airT = 0;
      if(!seg.ridden){ seg.ridden = true; world.score += 10; }   // 새 구름으로 갈아타기 성공 +10
      p.rideSeg = seg;
      // 타는 동안 구름이 서서히 닳는다 — 다 흩어지기 전에 갈아타야 함
      seg.life = (seg.life==null ? 1 : seg.life) - dt/Math.max(2, CFG.rideLife - world.dist*0.0004);
      if(seg.life <= 0){
        for(let k=0;k<12;k++)
          world.particles.push({x:seg.x+Math.random()*seg.w, y:p.y+16+(Math.random()-0.5)*10,
            vx:(Math.random()-0.5)*120, vy:20+Math.random()*60,
            life:0.6, max:0.6, hue:0, sat:0, lum:92, size:3+Math.random()*4});
        world.terrain[i] = world.terrain[i].filter(s=>s!==seg);
        p.rideSeg = null; p.riding = false;
      }
    } else { p.airT += dt; p.rideSeg = null; }

    const target = levelY(lane, p.level) + (p.riding ? Math.sin(tNow*2.5 + i*2)*3 : 0);  // 탑승 중엔 둥실둥실
    p.prevY = p.y;
    p.vy += (target - p.y) * 90 * dt;   // 스프링 — 살짝 출렁이며 안착
    p.vy *= Math.exp(-7*dt);
    p.y += p.vy * dt;
    p.y = clamp(p.y, lane.top+12, lane.bottom-12);

    const near = Math.abs(p.y - target) < 14;
    if(!p.settled && near && Math.abs(p.vy) > 50){
      p.landT = tNow;   // 안착 — 뽀잉 + 구름 퍼프
      for(let k=0;k<7;k++)
        world.particles.push({x:p.x+(Math.random()-0.5)*30, y:p.y+16, vx:(Math.random()-0.5)*120, vy:10+Math.random()*50,
          life:0.45, max:0.45, hue:0, sat:0, lum:94, size:3+Math.random()*3});
    }
    p.settled = near;

    if(p.ctrlActive && Math.random() < 0.6)
      world.particles.push({x:p.x-16, y:p.y+6, vx:-spd*0.4-40, vy:(Math.random()-0.5)*30,
        life:0.6, max:0.6, hue:p.hue + (p.level/(CFG.levels-1))*140, size:3.5+Math.random()*3});
  });

  // 구름을 타고 있어야 온전한 속도 — 공중에 오래 떠 있을수록 느려진다 (최저 25%)
  const rideAvg = players.reduce((a,p)=>a+(p.riding?1:Math.max(0.25, 1-1.2*p.airT)),0)/players.length;

  // --- 전진: 구름을 타고 있을 때 온전한 속도, 공중에선 점점 느려짐 ---
  world.speed = Math.min(CFG.maxSpeed, CFG.startSpeed + world.dist*0.025);
  const dx = spd*rideAvg*dt;
  world.dist += dx;
  world.score += dx*0.03;
  players.forEach((p,i)=>{
    for(const s of world.terrain[i]){
      if(s === p.rideSeg) continue;   // 타고 있는 구름은 나를 태운 채 화면에 고정 — 배경만 흘러간다
      s.x -= dx;
    }
    world.terrain[i] = world.terrain[i].filter(s => s.x + s.w > -80);
    ensureTerrain(i);
  });

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
        world.score += 300; world.harmony = 0; world.flash = 0.5;
        for(let k=0;k<40;k++)
          world.particles.push({x:Math.random()*W, y:Math.random()*H, vx:(Math.random()-0.5)*120, vy:-40-Math.random()*80,
            life:0.9, max:0.9, hue:45+Math.random()*40, size:3+Math.random()*3});
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
// 뭉게구름 한 덩어리 (x=왼쪽 끝, topY=올라타는 면, w=폭) — k 기반 크기라 프레임마다 안 흔들림
function drawCloud(x, topY, w){
  const n = Math.max(3, Math.round(w/36));
  ctx.beginPath();
  for(let k=0;k<n;k++){
    const cx = x + (k+0.5)*(w/n);
    const r = 14 + ((k*7)%3)*4 + ((k===0||k===n-1)?0:4);
    ctx.moveTo(cx+r, topY+8);
    ctx.arc(cx, topY+8, r, 0, 6.29);
  }
  ctx.fill();
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
  players.forEach((p,i)=>{
    if(p.name){
      ctx.globalAlpha = 0.55; ctx.fillStyle='#fff';
      ctx.font='14px sans-serif'; ctx.textAlign='left'; ctx.textBaseline='alphabetic';
      ctx.fillText(p.emoji+' '+p.name, 14, ls[i].top+18);
      ctx.globalAlpha = 1;
    }
  });

  // 구름 층 가이드 (현재 층은 밝게)
  players.forEach((p,i)=>{
    const lane = ls[i];
    const half = rowHalf(lane);
    for(let L=0; L<CFG.levels; L++){
      const y = levelY(lane, L);
      ctx.fillStyle = L===p.level ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.03)';
      ctx.fillRect(0, y-half, W, half*2);
    }
  });

  // 구름: 내가 탄 구름 + 다음 구름 하나 (다음 구름은 뭉게뭉게 생겨남)
  players.forEach((p,i)=>{
    const lane = ls[i];
    for(const s of world.terrain[i]){
      if(s.x > W + 60 || s.x + s.w < -60) continue;
      const grow = clamp((tNow - (s.born||-9))/0.5, 0, 1);
      const life = s.life==null ? 1 : Math.max(0, s.life);
      const effW = s.w*(0.35 + 0.65*grow)*(0.45 + 0.55*life);   // 닳을수록 작아지고 옅어짐
      const effX = s.x + (s.w - effW)/2;
      const y = (s === p.rideSeg) ? p.y + 16 : levelY(lane, s.level)+14;  // 타는 구름은 나와 함께 출렁
      ctx.globalAlpha = (0.35 + 0.57*grow)*(0.35 + 0.65*life);
      ctx.fillStyle = '#ffffff';
      drawCloud(effX, y, effW);
      ctx.globalAlpha = 1;
    }
    // 다음 구름의 상대 높이 안내 화살표
    const nxt = world.terrain[i].filter(s=>s.x > p.x + p.r).sort((a,b)=>a.x-b.x)[0];
    if(nxt){
      const diff = nxt.level - p.level;
      if(diff !== 0){
        ctx.fillStyle = '#ffd166'; ctx.font = 'bold 18px sans-serif';
        ctx.textAlign='center'; ctx.textBaseline='middle';
        const sym = diff > 0 ? '↑'.repeat(Math.min(diff,3)) : '↓'.repeat(Math.min(-diff,3));
        ctx.fillText(sym, nxt.x + nxt.w/2, levelY(lane, nxt.level) - 28);
      }
    }
  });

  // 파티클
  for(const pa of world.particles){
    ctx.globalAlpha = clamp(pa.life/pa.max, 0, 1)*0.9;
    ctx.fillStyle = 'hsl('+pa.hue+','+(pa.sat!=null?pa.sat:85)+'%,'+(pa.lum!=null?pa.lum:65)+'%)';
    ctx.beginPath(); ctx.arc(pa.x, pa.y, pa.size, 0, 6.29); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 플레이어 (구름을 타고 있음)
  players.forEach((p)=>{
    const rot = clamp((p.y - p.prevY)*0.06, -0.5, 0.5);
    const scale = 1 + clamp(p.voice.rms*4, 0, 0.4);
    ctx.textAlign='center'; ctx.textBaseline='middle';
    const lt = tNow - p.landT;
    let sqx = 1, sqy = 1;
    if(lt < 0.3){ const k = 1 - lt/0.3; sqx = 1 + 0.35*k; sqy = 1 - 0.35*k; }  // 안착 뽀잉
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(rot);
    ctx.scale(-scale*sqx, scale*sqy);   // 이모지가 왼쪽을 봐서 좌우 반전 (진행 방향인 오른쪽 보게)
    ctx.font='34px serif';
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
  if(world.t < 7){
    ctx.globalAlpha = clamp((7-world.t)/1.5, 0, 1)*0.8;
    ctx.fillStyle='#fff'; ctx.font='18px sans-serif'; ctx.textAlign='center';
    const hint = mode==='solo'
      ? '🎵 허밍하면 구름이 나를 태우고 날아가요 · 구름이 흩어지기 전에 ↑↓만큼 도약해서 갈아타기!'
      : '🎵 각자 구름을 타고 허밍! 흩어지기 전에 ↑↓만큼 도약해 갈아타기 · 화음 = 게이지 ✨';
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
  const l = lanes()[i], yBot = l.bottom-28, yTop = l.top+30;
  const t = clamp((yBot - y)/(yBot - yTop), 0, 1);
  overrides[i] = {level: Math.round(t*(CFG.levels-1))};
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
  try{ const l = JSON.parse(localStorage.getItem('cloudHummerScores')); return Array.isArray(l)?l:[]; }catch(e){ return []; }
}
function logScore(){
  if(!world || state!=='play') return;
  const s = Math.floor(world.score);
  if(s < 10) return;
  const list = loadScores();
  list.push({ n: mode==='solo' ? getName(0) : getName(0)+' & '+getName(1),
              m: mode, s, d: new Date().toISOString().slice(0,10) });
  list.sort((a,b)=>b.s-a.s);
  if(list.length > 100) list.length = 100;
  try{ localStorage.setItem('cloudHummerScores', JSON.stringify(list)); }catch(e){}
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
    row.querySelector('.nm').textContent = e.n;
    box.appendChild(row);
  });
}

// ===================== 메뉴 =====================
async function chooseMode(m){
  mode = m; buildPlayers();
  const ok = await initAudio();
  $('menu').classList.add('hidden');
  if(ok && mode==='duet'){ startCalib(); return; }   // 솔로는 상대 음정만 쓰므로 캘리브레이션 불필요
  if(ok){ players[0].analyser = audio.calibAnalyser; players[0].det = [55,1500]; }
  startRun();
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
