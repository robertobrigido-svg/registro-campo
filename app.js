'use strict';
/* Registro de Campo · Jota Barros. Tudo fica no celular (IndexedDB). */

// ---------- utilidades ----------
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const dataBR = ts => { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
const horaBR = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const diaISO = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const num = (v, c) => v.toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
function mostrar(tela) {
  for (const id of ['tela-inicio', 'tela-audio', 'tela-exportar', 'tela-detalhe']) $(id).hidden = id !== tela;
  window.scrollTo(0, 0);
}
function localTxt(r) {
  if (r.lat == null) return 'Local não disponível';
  return `${num(r.lat, 6)}, ${num(r.lon, 6)}` + (r.precisao ? ` (±${Math.round(r.precisao)} m)` : '');
}

// ---------- banco local ----------
const BD = 'registro-campo', LOJA = 'registros';
let _db;
function abrirBD() {
  if (_db) return Promise.resolve(_db);
  return new Promise((ok, erro) => {
    const rq = indexedDB.open(BD, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(LOJA, { keyPath: 'id' }).createIndex('ts', 'ts');
    rq.onsuccess = () => { _db = rq.result; ok(_db); };
    rq.onerror = () => erro(rq.error);
  });
}
async function tx(modo, fn) {
  const db = await abrirBD();
  return new Promise((ok, erro) => {
    const t = db.transaction(LOJA, modo); const r = fn(t.objectStore(LOJA));
    t.oncomplete = () => ok(r && r.result); t.onerror = () => erro(t.error); t.onabort = () => erro(t.error);
  });
}
const salvarReg = r => tx('readwrite', s => s.put(r));
const apagarReg = id => tx('readwrite', s => s.delete(id));
const lerTodos = async () => (await tx('readonly', s => s.getAll())).sort((a, b) => a.ts - b.ts);
const lerReg = id => tx('readonly', s => s.get(id));

// ---------- EXIF (foto original fica intacta; só lemos) ----------
async function lerExif(blob) {
  const saida = {};
  try {
    const buf = await blob.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return saida;
    let p = 2;
    while (p + 4 < v.byteLength) {
      const marc = v.getUint16(p), tam = v.getUint16(p + 2);
      if (marc === 0xFFE1 && v.getUint32(p + 4) === 0x45786966) { lerTiff(v, p + 10, saida); break; }
      if ((marc & 0xFF00) !== 0xFF00 || marc === 0xFFDA) break;
      p += 2 + tam;
    }
  } catch (e) { /* sem EXIF legível */ }
  return saida;
}
function lerTiff(v, ini, saida) {
  const le = v.getUint16(ini) === 0x4949;
  const u16 = o => v.getUint16(ini + o, le), u32 = o => v.getUint32(ini + o, le);
  const tamTipo = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
  function ifd(off) {
    const m = {}; const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12, tag = u16(e), tipo = u16(e + 2), cnt = u32(e + 4);
      const total = (tamTipo[tipo] || 1) * cnt;
      const vo = total <= 4 ? e + 8 : u32(e + 8);
      m[tag] = { tipo, cnt, vo };
    }
    return m;
  }
  const str = t => { let s = ''; for (let i = 0; i < t.cnt - 1; i++) s += String.fromCharCode(v.getUint8(ini + t.vo + i)); return s; };
  const racional = (t, i) => u32(t.vo + i * 8) / (u32(t.vo + i * 8 + 4) || 1);
  const ifd0 = ifd(u32(4));
  if (ifd0[0x8769]) {
    const ex = ifd(u32(ifd0[0x8769].vo));
    const dt = ex[0x9003] || ex[0x9004];
    if (dt) {
      const m = str(dt).match(/(\d+):(\d+):(\d+) (\d+):(\d+):(\d+)/);
      if (m) saida.dataHora = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    }
  }
  if (ifd0[0x8825]) {
    const g = ifd(u32(ifd0[0x8825].vo));
    if (g[2] && g[4]) {
      const graus = t => racional(t, 0) + racional(t, 1) / 60 + racional(t, 2) / 3600;
      let lat = graus(g[2]), lon = graus(g[4]);
      if (g[1] && str(g[1]) === 'S') lat = -lat;
      if (g[3] && str(g[3]) === 'W') lon = -lon;
      if (isFinite(lat) && isFinite(lon) && (lat || lon)) { saida.lat = lat; saida.lon = lon; }
    }
    if (g[0x1D] && g[7]) {
      const m = str(g[0x1D]).match(/(\d+):(\d+):(\d+)/);
      if (m) saida.gpsData = Date.UTC(+m[1], +m[2] - 1, +m[3], Math.round(racional(g[7], 0)), Math.round(racional(g[7], 1)), Math.round(racional(g[7], 2)));
    }
  }
}

// ---------- GPS do aparelho (complemento, caso a foto não traga a posição) ----------
let ultimaPos = null, watchId = null;
function iniciarGPS() {
  const aviso = $('aviso-gps');
  if (!('geolocation' in navigator)) { aviso.textContent = 'Este aparelho não oferece GPS ao navegador.'; return; }
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(
    p => { ultimaPos = { lat: p.coords.latitude, lon: p.coords.longitude, precisao: p.coords.accuracy, ts: p.timestamp }; aviso.textContent = ''; },
    e => { aviso.textContent = e.code === 1 ? 'Permita o acesso à localização para registrar o local das fotos.' : 'Sem sinal de GPS no momento.'; },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
}
function pararGPS() { if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }

// ---------- fluxo: foto -> áudio -> salvar ----------
let rascunho = null;
$('btn-foto').addEventListener('click', () => {
  iniciarGPS();
  $('entrada-foto').value = '';
  $('entrada-foto').click();
});
$('entrada-foto').addEventListener('change', async ev => {
  const arq = ev.target.files[0]; if (!arq) return;
  const agora = Date.now();
  const exif = await lerExif(arq);
  const r = { id: (crypto.randomUUID ? crypto.randomUUID() : String(agora) + Math.random()), foto: arq, fotoNome: arq.name, fotoTipo: arq.type, audio: null, audioTipo: null, transcricao: '' };
  // local: GPS gravado na foto; se faltar, a posição lida pelo aparelho
  if (exif.lat != null) { r.lat = exif.lat; r.lon = exif.lon; r.fonteLocal = 'foto'; }
  else if (ultimaPos) { r.lat = ultimaPos.lat; r.lon = ultimaPos.lon; r.precisao = ultimaPos.precisao; r.fonteLocal = 'aparelho'; }
  else { r.lat = null; r.lon = null; r.fonteLocal = null; }
  // horário: GPS da foto, depois hora da foto, depois relógio do aparelho
  if (exif.gpsData) { r.ts = exif.gpsData; r.fonteHora = 'gps da foto'; }
  else if (exif.dataHora) { r.ts = exif.dataHora; r.fonteHora = 'hora da foto'; }
  else if (ultimaPos) { r.ts = ultimaPos.ts; r.fonteHora = 'gps do aparelho'; }
  else { r.ts = agora; r.fonteHora = 'relógio do aparelho'; }
  rascunho = r;
  $('previa').src = URL.createObjectURL(arq);
  $('info-local').textContent = `${dataBR(r.ts)} ${horaBR(r.ts)} · ${localTxt(r)}`;
  $('texto').value = ''; $('tocar').hidden = true; $('tocar').removeAttribute('src');
  $('status-audio').textContent = 'Toque em gravar e fale o comentário sobre a foto.';
  $('btn-gravar').textContent = 'Gravar comentário';
  mostrar('tela-audio');
  if (r.fonteLocal == null) toast('Foto sem localização. Aguarde o GPS ou salve assim mesmo.');
});

// gravação de áudio + transcrição (quando o navegador oferece)
let gravador = null, pedacos = [], reconhecimento = null, textoFinal = '', gravando = false;
function tipoAudio() {
  for (const t of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']) if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  return '';
}
function iniciarTranscricao() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $('status-audio').textContent = 'Gravando. Este navegador não transcreve; digite o texto depois, se quiser.'; return; }
  textoFinal = $('texto').value ? $('texto').value.trim() + ' ' : '';
  reconhecimento = new SR(); reconhecimento.lang = 'pt-BR'; reconhecimento.continuous = true; reconhecimento.interimResults = true;
  reconhecimento.onresult = e => {
    let parcial = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) textoFinal += e.results[i][0].transcript.trim() + ' '; else parcial += e.results[i][0].transcript;
    }
    $('texto').value = (textoFinal + parcial).trim();
  };
  reconhecimento.onerror = () => { $('status-audio').textContent = 'Gravando. A transcrição precisa de internet; digite o texto depois, se quiser.'; };
  reconhecimento.onend = () => { if (gravando) { try { reconhecimento.start(); } catch (e) { /* já ativo */ } } };
  try { reconhecimento.start(); } catch (e) { /* ignora */ }
}
async function comecarGravar() {
  try {
    const fluxo = await navigator.mediaDevices.getUserMedia({ audio: true });
    const tipo = tipoAudio();
    gravador = new MediaRecorder(fluxo, tipo ? { mimeType: tipo } : undefined);
    pedacos = [];
    gravador.ondataavailable = e => { if (e.data.size) pedacos.push(e.data); };
    gravador.onstop = () => {
      fluxo.getTracks().forEach(t => t.stop());
      const mime = gravador.mimeType || tipo || 'audio/webm';
      rascunho.audio = new Blob(pedacos, { type: mime }); rascunho.audioTipo = mime;
      $('tocar').src = URL.createObjectURL(rascunho.audio); $('tocar').hidden = false;
    };
    gravador.start(); gravando = true;
    $('btn-gravar').textContent = 'Parar gravação'; $('btn-gravar').classList.add('gravando');
    $('status-audio').textContent = 'Gravando...';
    iniciarTranscricao();
  } catch (e) {
    $('status-audio').textContent = 'Não consegui usar o microfone. Permita o acesso ou digite o comentário.';
  }
}
function pararGravar() {
  gravando = false;
  if (reconhecimento) { try { reconhecimento.stop(); } catch (e) { /* ok */ } }
  if (gravador && gravador.state !== 'inactive') gravador.stop();
  $('btn-gravar').textContent = 'Gravar de novo'; $('btn-gravar').classList.remove('gravando');
  $('status-audio').textContent = 'Áudio gravado. Conferindo se saiu texto...';
  setTimeout(() => {
    if (gravando || ditando) return;
    $('status-audio').textContent = $('texto').value.trim()
      ? 'Áudio gravado. Confira o texto e salve.'
      : 'Áudio gravado, mas o celular não devolveu texto. Toque em "Ditar o texto" ou use o microfone do teclado.';
  }, 1200);
}

// ditado sem gravar: só o reconhecimento de voz, para não disputar o microfone com a gravação
let ditando = false, ditado = null;
function pararDitado() {
  ditando = false;
  if (ditado) { try { ditado.stop(); } catch (e) { /* ok */ } }
  $('btn-ditar').textContent = 'Ditar o texto';
  $('btn-ditar').classList.remove('gravando');
}
$('btn-ditar').addEventListener('click', () => {
  if (ditando) { pararDitado(); return; }
  if (gravando) pararGravar();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $('status-audio').textContent = 'Este navegador não faz ditado. Use o microfone do teclado do celular.'; return; }
  let base = $('texto').value.trim(); base = base ? base + ' ' : '';
  ditado = new SR(); ditado.lang = 'pt-BR'; ditado.continuous = false; ditado.interimResults = true;
  ditado.onresult = e => {
    let t = ''; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
    $('texto').value = (base + t).trim();
  };
  ditado.onerror = e => {
    $('status-audio').textContent = e.error === 'not-allowed' || e.error === 'service-not-allowed'
      ? 'O navegador não liberou o ditado. Use o microfone do teclado do celular.'
      : 'O ditado falhou (' + e.error + '). Precisa de internet. Use o microfone do teclado, se preferir.';
  };
  ditado.onend = () => { if (ditando) pararDitado(); };
  try {
    ditado.start(); ditando = true;
    $('btn-ditar').textContent = 'Parar ditado'; $('btn-ditar').classList.add('gravando');
    $('status-audio').textContent = 'Ouvindo. Fale o comentário.';
  } catch (e) { $('status-audio').textContent = 'Não consegui iniciar o ditado.'; }
});
$('btn-gravar').addEventListener('click', () => (gravando ? pararGravar() : comecarGravar()));
$('btn-descartar').addEventListener('click', () => {
  if (gravando) pararGravar();
  if (confirm('Descartar esta foto e o comentário?')) { rascunho = null; mostrar('tela-inicio'); }
});
$('btn-salvar').addEventListener('click', async () => {
  if (gravando) pararGravar();
  await new Promise(r => setTimeout(r, 250)); // deixa o gravador fechar o áudio
  rascunho.transcricao = $('texto').value.trim();
  try {
    await salvarReg(rascunho);
    toast('Registro salvo no celular.');
    rascunho = null; mostrar('tela-inicio'); await atualizarLista();
  } catch (e) { toast('Não consegui salvar. Verifique o espaço do celular.'); }
});

// ---------- lista e detalhe ----------
async function atualizarLista() {
  const todos = await lerTodos(); const hoje = diaISO(Date.now());
  const doDia = todos.filter(r => diaISO(r.ts) === hoje);
  $('kpi-hoje').textContent = doDia.length; $('kpi-total').textContent = todos.length;
  const ul = $('lista'); ul.textContent = '';
  if (!doDia.length) { ul.innerHTML = '<li class="vazio">Nenhum registro hoje.</li>'; return; }
  for (const r of doDia.slice().reverse()) {
    const li = document.createElement('li'); li.className = 'item';
    const img = document.createElement('img'); img.src = URL.createObjectURL(r.foto); img.alt = '';
    const d = document.createElement('div');
    d.innerHTML = `<b>${horaBR(r.ts)}</b><small>${esc(localTxt(r))}</small><p>${esc(r.transcricao || (r.audio ? 'Áudio sem texto' : 'Sem comentário'))}</p>`;
    li.append(img, d); li.addEventListener('click', () => abrirDetalhe(r.id)); ul.append(li);
  }
}
async function abrirDetalhe(id) {
  const r = await lerReg(id); if (!r) return;
  $('det-foto').src = URL.createObjectURL(r.foto);
  $('det-meta').textContent = `${dataBR(r.ts)} ${horaBR(r.ts)} · ${localTxt(r)}`;
  const a = $('det-audio'); if (r.audio) { a.src = URL.createObjectURL(r.audio); a.hidden = false; } else { a.hidden = true; a.removeAttribute('src'); }
  $('det-texto').textContent = r.transcricao || '';
  $('det-excluir').onclick = async () => { if (confirm('Excluir este registro? Não dá para desfazer.')) { await apagarReg(id); mostrar('tela-inicio'); atualizarLista(); } };
  mostrar('tela-detalhe');
}
$('det-voltar').addEventListener('click', () => mostrar('tela-inicio'));

// ---------- exportação ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
async function montarZip(arquivos) { // arquivos: [{nome, dados: Blob|Uint8Array}], sem compressão
  const enc = new TextEncoder(), partes = [], central = []; let desloc = 0;
  const agora = new Date(); const dosT = (agora.getHours() << 11) | (agora.getMinutes() << 5) | (agora.getSeconds() >> 1);
  const dosD = ((agora.getFullYear() - 1980) << 9) | ((agora.getMonth() + 1) << 5) | agora.getDate();
  for (const a of arquivos) {
    const u8 = a.dados instanceof Blob ? new Uint8Array(await a.dados.arrayBuffer()) : a.dados;
    const nome = enc.encode(a.nome), crc = crc32(u8);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dosT, true); h.setUint16(12, dosD, true); h.setUint32(14, crc, true);
    h.setUint32(18, u8.length, true); h.setUint32(22, u8.length, true); h.setUint16(26, nome.length, true); h.setUint16(28, 0, true);
    partes.push(h.buffer, nome, u8);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(12, dosT, true); c.setUint16(14, dosD, true); c.setUint32(16, crc, true);
    c.setUint32(20, u8.length, true); c.setUint32(24, u8.length, true); c.setUint16(28, nome.length, true); c.setUint32(42, desloc, true);
    central.push(c.buffer, nome);
    desloc += 30 + nome.length + u8.length;
  }
  const tamC = central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
  const fim = new DataView(new ArrayBuffer(22));
  fim.setUint32(0, 0x06054b50, true); fim.setUint16(8, arquivos.length, true); fim.setUint16(10, arquivos.length, true);
  fim.setUint32(12, tamC, true); fim.setUint32(16, desloc, true);
  return new Blob([...partes, ...central, fim.buffer], { type: 'application/zip' });
}
async function reduzir(blob, max = 1400) { // cópia leve só para o relatório; o original segue no pacote
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const esc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * esc); c.height = Math.round(bmp.height * esc);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const jpg = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
    return await blobParaURI(jpg);
  } catch (e) { return await blobParaURI(blob); }
}
const blobParaURI = b => new Promise(ok => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); });
const extFoto = r => (/png/.test(r.fotoTipo) ? 'png' : /heic|heif/.test(r.fotoTipo) ? 'heic' : 'jpg');
const extAudio = r => (/mp4|aac|m4a/.test(r.audioTipo) ? 'm4a' : /ogg/.test(r.audioTipo) ? 'ogg' : 'webm');
const seq = i => String(i + 1).padStart(3, '0');

function csv(regs) {
  const cab = ['Nº', 'Data', 'Hora', 'Latitude', 'Longitude', 'Precisão (m)', 'Origem do local', 'Origem da hora', 'Comentário', 'Foto', 'Áudio'];
  const cel = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const linhas = regs.map((r, i) => [i + 1, dataBR(r.ts), horaBR(r.ts), r.lat == null ? '' : num(r.lat, 6), r.lon == null ? '' : num(r.lon, 6),
    r.precisao ? Math.round(r.precisao) : '', r.fonteLocal || '', r.fonteHora || '', r.transcricao, `fotos/${seq(i)}.${extFoto(r)}`, r.audio ? `audios/${seq(i)}.${extAudio(r)}` : ''].map(cel).join(';'));
  return '﻿' + [cab.map(cel).join(';'), ...linhas].join('\r\n');
}

async function relatorioHTML(regs, meta, logoURI) {
  const dia = dataBR(regs[0].ts);
  const itens = [];
  for (let i = 0; i < regs.length; i++) {
    const r = regs[i]; const img = await reduzir(r.foto);
    itens.push(`<section class="reg"><div class="num">Foto ${i + 1} de ${regs.length}</div><img src="${img}" alt="Foto ${i + 1}">
<table><tr><th>Local</th><td>${r.lat == null ? 'Não disponível' : `Lat. ${num(r.lat, 6)} · Long. ${num(r.lon, 6)}`}</td></tr>
<tr><th>Data</th><td>${dataBR(r.ts)}</td></tr><tr><th>Hora</th><td>${horaBR(r.ts)}</td></tr>
<tr><th>Comentário</th><td>${r.transcricao ? esc(r.transcricao) : 'Sem comentário'}</td></tr></table></section>`);
  }
  const hoje = dataBR(Date.now());
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relatório fotográfico ${dia}</title><style>
@page{size:A4;margin:12mm}*{box-sizing:border-box}
body{font-family:Arial,Helvetica,sans-serif;color:#1E1B2B;margin:0;font-size:11pt;background:#fff}
.faixa{background:#2A1C47;color:#fff;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #BFBFBF}
.faixa h1{margin:0;font-size:22pt}.faixa p{margin:4px 0 0;color:#DCD7EA;font-size:11pt}
.faixa .logo{background:#fff;padding:5px 7px;border-radius:4px;display:flex}.faixa .logo img{height:18mm;display:block}
.dados{display:flex;gap:10px;margin:14px 0;flex-wrap:wrap}.dados div{background:#F1EFF6;border:1px solid #E6E3EE;border-radius:6px;padding:8px 12px;min-width:30%}
.dados span{display:block;font-size:8pt;color:#66667A}.dados b{font-size:12pt;color:#2A1C47}
.reg{break-inside:avoid;page-break-inside:avoid;border:1px solid #E6E3EE;border-radius:8px;padding:10px;margin:0 0 12px}
.num{font-weight:bold;color:#2A1C47;font-size:12pt;margin-bottom:6px}
.reg img{width:100%;max-height:105mm;object-fit:contain;display:block;background:#F1EFF6;border-radius:4px}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #BFBFBF;padding:5px 8px;text-align:left;vertical-align:top;font-size:10pt}
th{background:#2A1C47;color:#fff;width:24%}tr:nth-child(even) td{background:#F1EFF6}
.rodape{border-top:1px solid #BFBFBF;margin-top:14px;padding-top:6px;font-size:8pt;color:#66667A;display:flex;justify-content:space-between}
.rodape b{color:#2A1C47}
@media screen and (max-width:600px){.faixa h1{font-size:15pt}.faixa .logo img{height:12mm}.dados div{min-width:100%}}
</style></head><body>
<div class="faixa"><div><h1>Relatório fotográfico de campo</h1><p>${esc(meta.obra || 'Local não informado')} · ${dia}</p></div><span class="logo"><img src="${logoURI}" alt="Jota Barros"></span></div>
<div class="dados"><div><span>Data</span><b>${dia}</b></div><div><span>Registros</span><b>${regs.length}</b></div><div><span>Responsável</span><b>${esc(meta.resp || '—')}</b></div></div>
${itens.join('\n')}
<div class="rodape"><span><b>JOTA BARROS PROJETOS E ASSESSORIA</b> · Relatório fotográfico de campo · ${dia}</span><span>Gerado em ${hoje}</span></div>
</body></html>`;
}

let ultimoPacote = null, ultimoRelatorioURL = null;
$('btn-exportar').addEventListener('click', async () => {
  $('data-exp').value = diaISO(Date.now());
  $('obra').value = localStorage.getItem('obra') || ''; $('resp').value = localStorage.getItem('resp') || '';
  $('resultado').hidden = true; await resumo(); mostrar('tela-exportar');
});
async function regsDoDia() { const d = $('data-exp').value; return (await lerTodos()).filter(r => diaISO(r.ts) === d); }
async function resumo() { const n = (await regsDoDia()).length; $('resumo-exp').textContent = n ? `${n} registro(s) nesta data.` : 'Nenhum registro nesta data.'; }
$('data-exp').addEventListener('change', resumo);
$('btn-voltar').addEventListener('click', () => mostrar('tela-inicio'));
$('btn-gerar').addEventListener('click', async () => {
  const regs = await regsDoDia(); if (!regs.length) { toast('Não há registros nesta data.'); return; }
  const meta = { obra: $('obra').value.trim(), resp: $('resp').value.trim() };
  localStorage.setItem('obra', meta.obra); localStorage.setItem('resp', meta.resp);
  $('btn-gerar').disabled = true; $('btn-gerar').textContent = 'Gerando...';
  try {
    const logoURI = await blobParaURI(await (await fetch('logo.png')).blob());
    const html = await relatorioHTML(regs, meta, logoURI);
    const arqs = [];
    regs.forEach((r, i) => { arqs.push({ nome: `fotos/${seq(i)}.${extFoto(r)}`, dados: r.foto }); if (r.audio) arqs.push({ nome: `audios/${seq(i)}.${extAudio(r)}`, dados: r.audio }); });
    const enc = new TextEncoder();
    arqs.push({ nome: 'registros.csv', dados: enc.encode(csv(regs)) });
    arqs.push({ nome: 'registros.json', dados: enc.encode(JSON.stringify(regs.map((r, i) => ({ n: i + 1, dataHora: new Date(r.ts).toISOString(), latitude: r.lat, longitude: r.lon, precisaoMetros: r.precisao ?? null, origemLocal: r.fonteLocal, origemHora: r.fonteHora, comentario: r.transcricao, foto: `fotos/${seq(i)}.${extFoto(r)}`, audio: r.audio ? `audios/${seq(i)}.${extAudio(r)}` : null })), null, 2)) });
    arqs.push({ nome: 'relatorio-fotografico.html', dados: enc.encode(html) });
    const nome = `registro-campo-${$('data-exp').value}.zip`;
    ultimoPacote = new File([await montarZip(arqs)], nome, { type: 'application/zip' });
    if (ultimoRelatorioURL) URL.revokeObjectURL(ultimoRelatorioURL);
    ultimoRelatorioURL = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    $('msg-resultado').textContent = `Pacote pronto: ${nome} (${(ultimoPacote.size / 1048576).toFixed(1).replace('.', ',')} MB), com ${regs.length} registro(s), fotos originais, áudios, tabela em ordem de horário e relatório.`;
    $('resultado').hidden = false;
    toast('Pacote pronto. Toque em "Enviar o pacote" ou em "Baixar o pacote".', 6000);
    $('resultado').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) { toast('Falha ao gerar o pacote: ' + e.message, 6000); }
  $('btn-gerar').disabled = false; $('btn-gerar').textContent = 'Gerar arquivos';
});
$('btn-compartilhar').addEventListener('click', async () => {
  if (!ultimoPacote) return;
  if (!navigator.share) { toast('Este navegador não abre o menu de compartilhar. Use "Baixar o pacote".', 7000); return; }
  if (!navigator.canShare || !navigator.canShare({ files: [ultimoPacote] })) {
    toast('Este navegador não deixa compartilhar arquivo ZIP direto. Use "Baixar o pacote" e envie pelo app Arquivos.', 8000); return;
  }
  try { await navigator.share({ files: [ultimoPacote], title: ultimoPacote.name }); }
  catch (e) { if (e.name !== 'AbortError') toast('O compartilhamento falhou (' + e.name + '). Use "Baixar o pacote".', 8000); }
});
$('btn-baixar').addEventListener('click', () => {
  if (!ultimoPacote) return;
  const a = document.createElement('a'); a.href = URL.createObjectURL(ultimoPacote); a.download = ultimoPacote.name; document.body.append(a); a.click(); a.remove();
});
$('btn-relatorio').addEventListener('click', () => { if (ultimoRelatorioURL) window.open(ultimoRelatorioURL, '_blank'); });

// ---------- início ----------
function redeEstado() { $('estado-rede').textContent = navigator.onLine ? 'Funciona sem internet' : 'Sem internet · tudo continua funcionando'; }
addEventListener('online', redeEstado); addEventListener('offline', redeEstado);
redeEstado();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
atualizarLista();
