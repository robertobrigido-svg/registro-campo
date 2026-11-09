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
  for (const id of ['tela-inicio', 'tela-audio', 'tela-exportar', 'tela-detalhe', 'tela-projeto']) $(id).hidden = id !== tela;
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
    const rq = indexedDB.open(BD, 2);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains(LOJA)) db.createObjectStore(LOJA, { keyPath: 'id' }).createIndex('ts', 'ts');
      if (!db.objectStoreNames.contains('sessoes')) db.createObjectStore('sessoes', { keyPath: 'id' });
    };
    rq.onsuccess = () => {
      _db = rq.result;
      _db.onversionchange = () => { _db.close(); _db = null; }; // outra aba ou versão nova pediu para atualizar o banco
      ok(_db);
    };
    rq.onblocked = () => toast('Feche as outras abas do app para atualizar os dados.', 8000);
    rq.onerror = () => erro(rq.error);
  });
}
async function tx(modo, fn, loja = LOJA) {
  const db = await abrirBD();
  return new Promise((ok, erro) => {
    const t = db.transaction(loja, modo); const r = fn(t.objectStore(loja));
    t.oncomplete = () => ok(r && r.result); t.onerror = () => erro(t.error); t.onabort = () => erro(t.error);
  });
}
const salvarReg = r => tx('readwrite', s => s.put(r));
const apagarReg = id => tx('readwrite', s => s.delete(id));
const lerTodos = async () => (await tx('readonly', s => s.getAll())).sort((a, b) => a.ts - b.ts);
const lerReg = id => tx('readonly', s => s.get(id));
const salvarSessao = s => tx('readwrite', st => st.put(s), 'sessoes');
const lerSessoes = async () => (await tx('readonly', st => st.getAll(), 'sessoes')).sort((a, b) => a.inicio - b.inicio);

// ---------- sessões: um bloco de trabalho com início e fim (ex.: manhã, tarde) ----------
async function sessaoAberta() { return (await lerSessoes()).filter(s => !s.fim).pop() || null; }
async function encerrarSessao(s) {
  const regs = (await lerTodos()).filter(r => r.sessaoId === s.id);
  s.fim = regs.length ? Math.max(...regs.map(r => r.ts)) : Date.now();
  await salvarSessao(s);
}
const seguro = t => String(t || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Sem nome';
// pasta da sessão no Drive: data, hora de início e nome opcional; o projeto é a pasta de cima
const pastaDaSessao = s => `${diaISO(s.inicio)} ${horaBR(s.inicio).slice(0, 2)}h${horaBR(s.inicio).slice(3, 5)}${s.nome ? ' - ' + seguro(s.nome) : ''}`;
async function novaSessao(projeto, nome, tipo) {
  for (const aberta of (await lerSessoes()).filter(x => !x.fim)) await encerrarSessao(aberta); // só uma sessão aberta por vez
  const hoje = diaISO(Date.now());
  const n = (await lerSessoes()).filter(s => diaISO(s.inicio) === hoje).length + 1;
  const s = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), projeto: projeto || '', nome: nome || '', tipo: tipo || 'infra', inicio: Date.now(), fim: null };
  await salvarSessao(s); return s;
}
async function garantirSessao() { // a primeira foto abre uma sessão sozinha; sessão de outro dia é encerrada
  let s = await sessaoAberta();
  if (s && diaISO(s.inicio) !== diaISO(Date.now())) { const { projeto, tipo, nome } = s; await encerrarSessao(s); return novaSessao(projeto, tipo === 'edificacao' ? nome : '', tipo); } // dia novo: mesmo projeto (e mesmo ambiente, em edificação), pasta nova, sem perguntar
  return s || novaSessao('Sem projeto', '');
}

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
function abrirCamera() { iniciarGPS(); $('entrada-foto').value = ''; $('entrada-foto').click(); }
$('btn-foto').addEventListener('click', async () => {
  const sessao = await sessaoAberta();
  if (sessao) abrirCamera(); else abrirTelaProjeto(true); // o projeto da última sessão segue valendo; só pergunta quando não há sessão aberta
});
let cameraDepois = false;
async function abrirTelaProjeto(comCamera) {
  cameraDepois = comCamera;
  const ultimas = (await lerSessoes()).slice().reverse();
  const projetos = [...new Set(ultimas.map(x => x.projeto).filter(Boolean))].slice(0, 6);
  const tipoPorProjeto = {}; ultimas.slice().reverse().forEach(x => { if (x.projeto) tipoPorProjeto[x.projeto] = x.tipo || 'infra'; }); // vale o tipo da sessão mais recente de cada projeto
  const marcarTipo = t => { document.querySelectorAll('input[name=proj-tipo]').forEach(i => { i.checked = i.value === t; }); rotularTipo(); };
  $('proj-nome').value = projetos[0] || ''; $('proj-sessao').value = ''; marcarTipo(tipoPorProjeto[projetos[0]] || 'infra');
  const box = $('proj-recentes'); box.textContent = '';
  projetos.forEach(p => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = p; b.onclick = () => { $('proj-nome').value = p; marcarTipo(tipoPorProjeto[p] || 'infra'); }; box.append(b); });
  $('btn-proj-iniciar').textContent = comCamera ? 'Iniciar e tirar foto' : 'Iniciar sessão';
  mostrar('tela-projeto');
}
const tipoEscolhido = () => (document.querySelector('input[name=proj-tipo]:checked') || {}).value || 'infra';
function rotularTipo() {
  const edif = tipoEscolhido() === 'edificacao';
  $('proj-sessao-rotulo').textContent = edif ? 'Ambiente onde vai começar (obrigatório)' : 'Nome da sessão (opcional)';
  $('proj-sessao').placeholder = edif ? 'Ex.: sala 101, fachada, cobertura' : 'Ex.: manhã';
}
document.querySelectorAll('input[name=proj-tipo]').forEach(i => i.addEventListener('change', rotularTipo));
$('btn-proj-cancelar').addEventListener('click', () => mostrar('tela-inicio'));
$('btn-proj-iniciar').addEventListener('click', async () => {
  const projeto = $('proj-nome').value.trim();
  if (!projeto) { toast('Informe o projeto ou o local.'); return; }
  const tipo = tipoEscolhido(), nomeSessao = $('proj-sessao').value.trim();
  if (tipo === 'edificacao' && !nomeSessao) { toast('Em edificação, informe o ambiente.'); return; }
  if (cameraDepois) abrirCamera(); // a câmera abre já, no mesmo toque; a sessão fica pronta antes de a foto voltar
  const aberta = await sessaoAberta(); if (aberta) await encerrarSessao(aberta);
  await novaSessao(seguro(projeto), nomeSessao ? seguro(nomeSessao) : '', tipo);
  mostrar('tela-inicio'); atualizarLista();
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
  const ses = await garantirSessao();
  r.sessaoId = ses.id; r.projeto = ses.projeto; r.tipo = ses.tipo || 'infra'; r.ambiente = r.tipo === 'edificacao' ? ses.nome : ''; // a foto guarda o contexto em que foi batida
  rascunho = r;
  pararGPS(); // já lemos a posição; deixar ligado gasta bateria
  // a foto é salva já, antes do comentário: se o celular fechar o app durante a câmera ou o áudio, a foto não se perde
  r.sha256 = await sha256(arq);
  try { await salvarReg(r); } catch (e) { toast('Não consegui guardar a foto. Verifique o espaço do celular.', 6000); }
  atualizarLista();
  $('previa').src = URL.createObjectURL(arq);
  $('info-local').textContent = `${dataBR(r.ts)} ${horaBR(r.ts)} · ${localTxt(r)}`;
  $('texto').value = ''; $('tocar').hidden = true; $('tocar').removeAttribute('src');
  $('status-audio').textContent = 'Toque em ditar e fale o comentário. O áudio gravado é opcional.';
  $('btn-gravar').textContent = 'Gravar áudio (opcional)';
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
  $('btn-ditar').textContent = 'Ditar o comentário';
  $('btn-ditar').classList.remove('gravando');
}
$('btn-ditar').addEventListener('click', () => {
  if (ditando) { pararDitado(); return; }
  if (gravando) pararGravar();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $('status-audio').textContent = 'Este navegador não faz ditado. Use o microfone do teclado do celular.'; return; }
  let base = $('texto').value.trim();
  const comOuSem = t => ((base ? base + ' ' : '') + t).trim();
  const abrir = () => {
    ditado = new SR(); ditado.lang = 'pt-BR'; ditado.continuous = false; ditado.interimResults = true;
    ditado.onresult = e => {
      const res = e.results[e.results.length - 1], t = res[0].transcript;
      $('texto').value = comOuSem(t);
      if (res.isFinal) base = $('texto').value;
    };
    ditado.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return; // silêncio: o fim da sessão reabre sozinho
      $('status-audio').textContent = e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'O navegador não liberou o ditado. Use o microfone do teclado do celular.'
        : 'O ditado falhou (' + e.error + '). Precisa de internet. Use o microfone do teclado, se preferir.';
      pararDitado();
    };
    ditado.onend = () => {
      base = $('texto').value.trim(); // guarda o que já apareceu, mesmo sem resultado final
      if (ditando) setTimeout(() => { if (ditando) { try { abrir(); } catch (e) { pararDitado(); } } }, 150); // pausa para pensar não encerra
    };
    ditado.start();
  };
  try {
    abrir(); ditando = true;
    $('btn-ditar').textContent = 'Parar ditado'; $('btn-ditar').classList.add('gravando');
    $('status-audio').textContent = 'Ouvindo. Fale o comentário.';
  } catch (e) { $('status-audio').textContent = 'Não consegui iniciar o ditado.'; }
});
$('btn-gravar').addEventListener('click', () => (gravando ? pararGravar() : comecarGravar()));
$('btn-descartar').addEventListener('click', async () => {
  if (gravando) pararGravar();
  if (ditando) pararDitado();
  if (confirm('Descartar esta foto e o comentário? Não dá para desfazer.')) {
    if (rascunho) await apagarReg(rascunho.id);
    rascunho = null; mostrar('tela-inicio'); atualizarLista();
  }
});
$('btn-salvar').addEventListener('click', async () => {
  if (gravando) pararGravar();
  if (ditando) pararDitado();
  await new Promise(r => setTimeout(r, 250)); // deixa o gravador fechar o áudio
  rascunho.transcricao = $('texto').value.trim();
  rascunho.transcricaoOriginal = rascunho.transcricao; // o texto como foi ditado ou digitado no campo; edições depois não mexem aqui
  try {
    await salvarReg(rascunho);
    toast('Registro salvo no celular.');
    if (driveCfg().auto) setTimeout(() => enviarPendentes(true), 400);
    rascunho = null; mostrar('tela-inicio'); await atualizarLista();
  } catch (e) { toast('Não consegui salvar. Verifique o espaço do celular.'); }
});

// ---------- troca de ambiente (edificação) ou de sessão (infraestrutura) em um toque ----------
async function trocarContexto(ses, nome) {
  if (ses.tipo === 'edificacao' && ses.nome === nome) return;
  await novaSessao(ses.projeto, nome, ses.tipo); toast(ses.tipo === 'edificacao' ? `Ambiente: ${nome}` : 'Nova sessão iniciada.'); atualizarLista();
}
async function montarContextoRapido(ses) {
  const box = $('ctx-rapido'); box.textContent = '';
  if (!ses) return;
  const chip = (txt, ativo, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + (ativo ? ' ativo' : ''); b.textContent = txt; b.onclick = fn; box.append(b); };
  if (ses.tipo === 'edificacao') {
    const ambientes = [...new Set((await lerSessoes()).filter(x => x.projeto === ses.projeto && x.tipo === 'edificacao' && x.nome).reverse().map(x => x.nome))].slice(0, 12);
    ambientes.forEach(a => chip(a, a === ses.nome, () => trocarContexto(ses, a)));
    chip('+ novo ambiente', false, () => { const a = prompt('Nome do ambiente', ''); if (a && a.trim()) trocarContexto(ses, seguro(a)); });
  } else {
    chip('+ nova sessão', false, () => { const a = prompt('Nome da nova sessão (pode deixar em branco)', ''); if (a !== null) trocarContexto(ses, a.trim() ? seguro(a) : ''); });
  }
}

// ---------- lista e detalhe ----------
async function atualizarLista() {
  const todos = await lerTodos(); const hoje = diaISO(Date.now());
  const doDia = todos.filter(r => diaISO(r.ts) === hoje);
  const pendentes = todos.filter(pendente).length;
  $('kpi-hoje').textContent = doDia.length; $('kpi-total').textContent = pendentes;
  $('btn-enviar').textContent = pendentes ? `Enviar para o Drive (${pendentes})` : 'Tudo enviado para o Drive';
  $('btn-enviar').disabled = enviando || !pendentes;
  estadoEnvio();
  const ses = await sessaoAberta();
  if (ses) {
    const n = todos.filter(r => r.sessaoId === ses.id).length;
    $('sessao-nome').textContent = ses.projeto || ses.nome || 'Sessão';
    const edif = ses.tipo === 'edificacao';
    $('sessao-info').textContent = `${edif ? 'Edificação' : 'Infraestrutura'} · ${ses.projeto && ses.nome ? (edif ? 'ambiente ' : '') + ses.nome + ' · ' : ''}desde ${horaBR(ses.inicio).slice(0, 5)} · ${n} foto(s)`;
  } else { $('sessao-nome').textContent = 'Nenhuma'; $('sessao-info').textContent = 'Ao tirar a primeira foto, o app pergunta o projeto.'; }
  $('btn-fim-sessao').disabled = !ses;
  await montarContextoRapido(ses);
  const ul = $('lista'); ul.textContent = '';
  if (!doDia.length) { ul.innerHTML = '<li class="vazio">Nenhum registro hoje.</li>'; return; }
  for (const r of doDia.slice().reverse()) {
    const li = document.createElement('li'); li.className = 'item';
    const img = document.createElement('img'); img.src = URL.createObjectURL(r.foto); img.alt = '';
    const d = document.createElement('div');
    d.innerHTML = `<b>${horaBR(r.ts)}</b> <span class="tag ${pendente(r) ? 'pend' : 'ok'}">${pendente(r) ? 'a enviar' : 'enviado'}</span><small>${esc(localTxt(r))}</small><p>${esc(r.transcricao || (r.audio ? 'Áudio sem texto' : 'Sem comentário'))}</p>`;
    li.append(img, d); li.addEventListener('click', () => abrirDetalhe(r.id)); ul.append(li);
  }
}
async function abrirDetalhe(id) {
  const r = await lerReg(id); if (!r) return;
  $('det-foto').src = URL.createObjectURL(r.foto);
  const sesDet = (await lerSessoes()).find(x => x.id === r.sessaoId);
  $('det-meta').textContent = `${dataBR(r.ts)} ${horaBR(r.ts)} · ${localTxt(r)}${sesDet ? ' · ' + (sesDet.projeto || sesDet.nome) : ''}`;
  const a = $('det-audio'); if (r.audio) { a.src = URL.createObjectURL(r.audio); a.hidden = false; } else { a.hidden = true; a.removeAttribute('src'); }
  $('det-texto').value = r.transcricao || '';
  $('det-voltar').dataset.id = id;
  $('det-salvar').onclick = async () => {
    const atual = await lerReg(id); if (!atual) return;
    atual.transcricao = $('det-texto').value.trim();
    await salvarReg(atual); toast('Comentário atualizado.'); atualizarLista();
  };
  $('det-excluir').onclick = async () => { if (confirm('Excluir este registro? Não dá para desfazer.')) { await apagarReg(id); mostrar('tela-inicio'); atualizarLista(); } };
  mostrar('tela-detalhe');
}
$('det-voltar').addEventListener('click', () => mostrar('tela-inicio'));

// ---------- enviar um registro só (WhatsApp, e-mail...), sem gerar o pacote ----------
function textoRegistro(r, comentario) {
  const l = ['Registro de campo · Jota Barros', `Data: ${dataBR(r.ts)} · Hora: ${horaBR(r.ts)}`];
  if (r.lat != null) {
    l.push(`Local: ${num(r.lat, 6)}; ${num(r.lon, 6)}${r.fonteLocal === 'aparelho' ? ' (GPS do aparelho)' : ''}`);
    l.push(`Mapa: https://www.google.com/maps?q=${r.lat.toFixed(6)},${r.lon.toFixed(6)}`);
  } else l.push('Local: não disponível');
  if (comentario) l.push(`Comentário: ${comentario}`);
  return l.join('\n');
}
async function enviarRegistro(id, original) {
  const r = await lerReg(id); if (!r) return;
  const texto = textoRegistro(r, $('det-texto').value.trim());
  const base = `foto-${diaISO(r.ts)}_${horaBR(r.ts).replace(/:/g, '')}`;
  let arq;
  if (original) arq = new File([r.foto], `${base}.${extFoto(r)}`, { type: r.fotoTipo || 'image/jpeg' });
  else { const b = await reduzirBlob(r.foto, r, 1600); arq = b ? new File([b], `${base}.jpg`, { type: 'image/jpeg' }) : new File([r.foto], `${base}.${extFoto(r)}`, { type: r.fotoTipo || 'image/jpeg' }); }
  if (navigator.canShare && navigator.canShare({ files: [arq] })) {
    try { await navigator.share({ files: [arq], text: texto, title: 'Registro de campo' }); }
    catch (e) { if (e.name !== 'AbortError') toast('O compartilhamento falhou (' + e.name + '). Use "Baixar a foto".', 8000); }
    return;
  }
  // este navegador não compartilha arquivo: baixa a foto e copia o texto para colar na conversa
  baixarArquivo(arq);
  try { await navigator.clipboard.writeText(texto); toast('Baixei a foto e copiei o texto. Anexe a foto na conversa e cole o texto.', 9000); }
  catch (e) { toast('Baixei a foto. O texto não pôde ser copiado.', 8000); }
}
function baixarArquivo(arq) { const a = document.createElement('a'); a.href = URL.createObjectURL(arq); a.download = arq.name; document.body.append(a); a.click(); a.remove(); }
$('det-enviar').addEventListener('click', () => enviarRegistro($('det-voltar').dataset.id, false));
$('det-enviar-original').addEventListener('click', () => enviarRegistro($('det-voltar').dataset.id, true));

$('btn-nova-sessao').addEventListener('click', () => abrirTelaProjeto(false));
$('btn-fim-sessao').addEventListener('click', async () => {
  const s = await sessaoAberta(); if (!s) return;
  if (confirm(`Encerrar a sessão "${s.projeto || s.nome}"? A próxima foto abre uma sessão nova.`)) { await encerrarSessao(s); toast('Sessão encerrada.'); atualizarLista(); }
});

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
    const corpo = a.dados instanceof Blob ? a.dados : u8; // guarda o arquivo, não a cópia em memória
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dosT, true); h.setUint16(12, dosD, true); h.setUint32(14, crc, true);
    h.setUint32(18, u8.length, true); h.setUint32(22, u8.length, true); h.setUint16(26, nome.length, true); h.setUint16(28, 0, true);
    partes.push(h.buffer, nome, corpo);
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
async function sha256(blob) { // impressão digital do arquivo original, para conferir depois se foi alterado
  try {
    const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return ''; }
}
function linhasCarimbo(r) {
  const orig = r.fonteLocal === 'aparelho' ? ' (GPS do aparelho)' : '';
  return [`${dataBR(r.ts)}  ${horaBR(r.ts)}`, r.lat == null ? 'Local não disponível' : `Lat ${num(r.lat, 6)}  Long ${num(r.lon, 6)}${orig}`];
}
let _simbolo = null;
async function carregarSimbolo() { if (!_simbolo) _simbolo = await createImageBitmap(await (await fetch('icons/icon-512.png')).blob()); return _simbolo; }
async function reduzirBlob(blob, r, max = 1400) { // cópia com data, hora e coordenadas gravadas na imagem; o original segue intacto; devolve null se falhar
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const esc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * esc); c.height = Math.round(bmp.height * esc);
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0, c.width, c.height);
    // faixa índigo translúcida no topo, com data e hora, coordenadas e o símbolo da Jota Barros em quadro branco (padrão dos relatórios)
    const W = c.width, longo = Math.max(c.width, c.height), curto = Math.min(c.width, c.height);
    const bh = Math.round(Math.min(longo * 0.075, curto * 0.14)), ln = linhasCarimbo(r);
    g.fillStyle = 'rgba(42,28,71,0.86)'; g.fillRect(0, 0, W, bh);
    g.fillStyle = '#BFBFBF'; g.fillRect(0, bh, W, Math.max(2, Math.round(bh * 0.025)));
    const lado = Math.round(bh * 0.8), mg = Math.round(bh * 0.1), tx = Math.round(bh * 0.2), livre = W - lado - mg * 3 - tx;
    let f1 = bh * 0.34, f2 = bh * 0.22;
    g.textBaseline = 'alphabetic'; g.fillStyle = '#fff';
    g.font = `bold ${f1}px Arial, Helvetica, sans-serif`; if (g.measureText(ln[0]).width > livre) f1 *= livre / g.measureText(ln[0]).width;
    g.font = `${f2}px Arial, Helvetica, sans-serif`; if (g.measureText(ln[1]).width > livre) f2 *= livre / g.measureText(ln[1]).width;
    g.font = `bold ${f1}px Arial, Helvetica, sans-serif`; g.fillText(ln[0], tx, bh * 0.46);
    g.font = `${f2}px Arial, Helvetica, sans-serif`; g.fillText(ln[1], tx, bh * 0.82);
    g.fillStyle = '#fff'; g.beginPath();
    if (g.roundRect) g.roundRect(W - lado - mg, mg, lado, lado, lado * 0.12); else g.rect(W - lado - mg, mg, lado, lado);
    g.fill();
    try { const simb = await carregarSimbolo(), m = lado * 0.08; g.drawImage(simb, W - lado - mg + m, mg + m, lado - 2 * m, lado - 2 * m); } catch (e) { /* sem símbolo: fica o quadro branco */ }
    const jpg = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
    return jpg;
  } catch (e) { return null; }
}
async function reduzir(blob, r, max = 1400) { const j = await reduzirBlob(blob, r, max); return blobParaURI(j || blob); } // para o relatório
const blobParaURI = b => new Promise(ok => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); });
const extFoto = r => (/png/.test(r.fotoTipo) ? 'png' : /heic|heif/.test(r.fotoTipo) ? 'heic' : 'jpg');
const extAudio = r => (/mp4|aac|m4a/.test(r.audioTipo) ? 'm4a' : /ogg/.test(r.audioTipo) ? 'ogg' : 'webm');
const seq = i => String(i + 1).padStart(3, '0');
// nome estável dos arquivos no Drive e nos pacotes: data, hora e começo do SHA-256 (não muda quando entram outros registros)
function nomesDe(r) {
  const stem = `${diaISO(r.ts).replace(/-/g, '')}_${horaBR(r.ts).replace(/:/g, '')}_${(r.sha256 || '').slice(0, 8)}`;
  const pre = r.tipo === 'edificacao' && r.ambiente ? seguro(r.ambiente) + '/' : ''; // edificação: uma pasta por ambiente
  return { foto: `${pre}fotos/${stem}.${extFoto(r)}`, audio: r.audio ? `${pre}audios/${stem}.${extAudio(r)}` : null };
}

function csv(regs, nomeSessao = () => '', projetoDe = () => '') {
  const cab = ['Nº', 'Data', 'Hora', 'Latitude', 'Longitude', 'Precisão (m)', 'Origem do local', 'Origem da hora', 'Projeto', 'Sessão', 'Comentário', 'Foto', 'Áudio', 'SHA-256 da foto'];
  const cel = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const linhas = regs.map((r, i) => [i + 1, dataBR(r.ts), horaBR(r.ts), r.lat == null ? '' : num(r.lat, 6), r.lon == null ? '' : num(r.lon, 6),
    r.precisao ? Math.round(r.precisao) : '', r.fonteLocal || '', r.fonteHora || '', projetoDe(r), nomeSessao(r), r.transcricao, nomesDe(r).foto, nomesDe(r).audio || '', r.sha256 || ''].map(cel).join(';'));
  return '﻿' + [cab.map(cel).join(';'), ...linhas].join('\r\n');
}

function resumoSessoes(regs, sessoes) { // por sessão: nome, primeira e última foto, quantidade
  const mapa = new Map();
  for (const r of regs) {
    const k = r.sessaoId || '';
    const g = mapa.get(k) || { nome: (sessoes.find(s => s.id === k) || {}).nome || 'Sem sessão', n: 0, ini: r.ts, fim: r.ts };
    g.n++; g.ini = Math.min(g.ini, r.ts); g.fim = Math.max(g.fim, r.ts); mapa.set(k, g);
  }
  return mapa;
}
async function relatorioHTML(regs, meta, logoURI, sessoes) {
  const dia = dataBR(regs[0].ts);
  const itens = [];
  const grupos = resumoSessoes(regs, sessoes);
  let sessaoAtual = null;
  for (let i = 0; i < regs.length; i++) {
    const r = regs[i]; const img = await reduzir(r.foto, r); const h = r.sha256 || await sha256(r.foto);
    if ((r.sessaoId || '') !== sessaoAtual) {
      sessaoAtual = r.sessaoId || '';
      const g = grupos.get(sessaoAtual);
      itens.push(`<h2 class="sessao">${esc(g.nome)} · ${horaBR(g.ini).slice(0, 5)} às ${horaBR(g.fim).slice(0, 5)} · ${g.n} foto(s)</h2>`);
    }
    itens.push(`<section class="reg"><div class="num">Foto ${i + 1} de ${regs.length}</div><img src="${img}" alt="Foto ${i + 1}">
<p class="com"><b>Comentário:</b> ${r.transcricao ? esc(r.transcricao) : 'Sem comentário'}</p>
<p class="hash">Arquivo original: ${nomesDe(r).foto} · SHA-256: ${h || 'não calculado'}</p></section>`);
  }
  const hoje = dataBR(Date.now());
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relatório fotográfico ${dia.replace(/\//g, '-')}</title><style>
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
.sessao{font-size:13pt;color:#2A1C47;border-bottom:2px solid #5B4B8A;padding-bottom:3px;margin:18px 0 10px;break-after:avoid}
.com{margin:8px 0 4px;font-size:10.5pt}.hash{margin:0;font-size:7pt;color:#66667A;word-break:break-all}
.nota{margin-top:12px;padding:8px 12px;background:#F1EFF6;border:1px solid #E6E3EE;border-radius:6px;font-size:8.5pt;color:#1E1B2B}
.rodape{border-top:1px solid #BFBFBF;margin-top:14px;padding-top:6px;font-size:8pt;color:#66667A;display:flex;justify-content:space-between}
.rodape b{color:#2A1C47}
@media screen and (max-width:600px){.faixa h1{font-size:15pt}.faixa .logo img{height:12mm}.dados div{min-width:100%}}
</style></head><body>
<div class="faixa"><div><h1>Relatório fotográfico de campo</h1><p>${esc(meta.obra || 'Local não informado')} · ${dia}</p></div><span class="logo"><img src="${logoURI}" alt="Jota Barros"></span></div>
<div class="dados"><div><span>Data</span><b>${dia}</b></div><div><span>Registros</span><b>${regs.length}</b></div><div><span>Responsável</span><b>${esc(meta.resp || '—')}</b></div><div><span>Sessões</span><b>${grupos.size}</b></div></div>
${itens.join('\n')}
<div class="nota"><b>Sobre a inalterabilidade.</b> A data, a hora e as coordenadas impressas em cada foto são cópia dos metadados gravados no arquivo original, entregue junto deste relatório na pasta fotos/. Para conferir uma foto, compare os metadados do arquivo original (data, hora e geolocalização) e o código SHA-256 acima. Se o arquivo for alterado, o código muda. O carimbo na imagem do relatório sozinho não prova que a foto não foi alterada.</div>
<div class="rodape"><span><b>JOTA BARROS PROJETOS E ASSESSORIA</b> · Relatório fotográfico de campo · ${dia}</span><span>Gerado em ${hoje}</span></div>
</body></html>`;
}

let ultimoPacote = null, ultimoRelatorioURL = null;

// ---------- estado de envio de cada registro ----------
// r.enviado = { arquivos: foto e áudio já estão no Drive, v: versão do comentário e da sessão que o Drive conhece }
const versaoReg = r => `${r.transcricao || ''}|${r.sessaoId || ''}`;
const pendente = r => !(r.enviado && r.enviado.arquivos && r.enviado.v === versaoReg(r));
async function atualizarReg(id, fn) { const a = await lerReg(id); if (!a) return; fn(a); await salvarReg(a); } // relê o registro, para não apagar uma edição feita durante o envio

// ---------- envio para o Google Drive (script do Google na conta do usuário; ver drive/INSTALAR-DRIVE.md) ----------
const driveCfg = () => ({ url: (localStorage.getItem('driveUrl') || '').trim(), senha: localStorage.getItem('driveSenha') || '', auto: localStorage.getItem('driveAuto') !== '0', rede: localStorage.getItem('driveRede') || 'ambos' });
function guardarDrive() { localStorage.setItem('driveUrl', $('drive-url').value.trim()); localStorage.setItem('driveSenha', $('drive-senha').value); localStorage.setItem('driveAuto', $('drive-auto').checked ? '1' : '0'); localStorage.setItem('driveRede', $('drive-rede').value); }
function carregarDrive() { const c = driveCfg(); $('drive-url').value = c.url; $('drive-senha').value = c.senha; $('drive-auto').checked = c.auto; $('drive-rede').value = c.rede; }
['drive-url', 'drive-senha', 'drive-auto', 'drive-rede'].forEach(id => $(id).addEventListener('change', guardarDrive));
async function chamarDrive(corpo) {
  const c = driveCfg();
  if (!c.url || !c.senha) throw new Error('Preencha o endereço e a senha do Drive.');
  let r;
  try { r = await fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ senha: c.senha, ...corpo }) }); }
  catch (e) { throw new Error('Não consegui falar com o Drive. Confira a internet, o endereço e se o script foi publicado.'); }
  let j; try { j = await r.json(); } catch (e) { throw new Error('Resposta inesperada do Drive. Confira se o endereço termina em /exec.'); }
  if (!j.ok) throw new Error(j.erro || 'Falha no Drive.');
  return j;
}
$('btn-drive-testar').addEventListener('click', async () => {
  guardarDrive(); $('drive-status').textContent = 'Testando...';
  try { $('drive-status').textContent = (await chamarDrive({ ping: true })).mensagem; }
  catch (e) { $('drive-status').textContent = 'Não conectou: ' + e.message; }
});
const blobB64 = b => new Promise(ok => { const f = new FileReader(); f.onload = () => ok(f.result.split(',')[1]); f.readAsDataURL(b); });
const tipoDe = n => /\.jpe?g$/i.test(n) ? 'image/jpeg' : /\.png$/i.test(n) ? 'image/png' : /\.heic$/i.test(n) ? 'image/heic' : /\.m4a$/i.test(n) ? 'audio/mp4' : /\.webm$/i.test(n) ? 'audio/webm' : /\.ogg$/i.test(n) ? 'audio/ogg' : /\.csv$/i.test(n) ? 'text/csv' : /\.json$/i.test(n) ? 'application/json' : /\.html$/i.test(n) ? 'text/html' : 'application/octet-stream';
const esperar = ms => new Promise(r => setTimeout(r, ms));

// monta tabela, JSON e relatório do dia (e, se pedido, as fotos e os áudios), com nomes estáveis
async function montarArquivos(regs, meta, comMidia, comRelatorio = true) {
  const sessoes = await lerSessoes();
  const nomeSessao = r => (sessoes.find(s => s.id === r.sessaoId) || {}).nome || '';
  const projetoDe = r => (sessoes.find(s => s.id === r.sessaoId) || {}).projeto || '';
  let html = '';
  if (comRelatorio) { const logoURI = await blobParaURI(await (await fetch('logo.png')).blob()); html = await relatorioHTML(regs, meta, logoURI, sessoes); } // o relatório do celular só entra no plano B; o do Drive é feito no PC
  const enc = new TextEncoder(), arqs = [];
  if (comMidia) regs.forEach(r => { const n = nomesDe(r); arqs.push({ nome: n.foto, dados: r.foto }); if (r.audio) arqs.push({ nome: n.audio, dados: r.audio }); });
  arqs.push({ nome: 'registros.csv', dados: enc.encode(csv(regs, nomeSessao, projetoDe)) });
  arqs.push({ nome: 'registros.json', dados: enc.encode(JSON.stringify(regs.map((r, i) => ({ n: i + 1, dataHora: new Date(r.ts).toISOString(), latitude: r.lat == null ? null : +r.lat.toFixed(6), longitude: r.lon == null ? null : +r.lon.toFixed(6), precisaoMetros: r.precisao ?? null, origemLocal: r.fonteLocal, origemHora: r.fonteHora, projeto: projetoDe(r) || r.projeto || '', tipo: r.tipo || 'infra', ambiente: r.ambiente || '', sessao: nomeSessao(r), comentario: r.transcricao, comentarioOriginal: r.transcricaoOriginal ?? r.transcricao, foto: nomesDe(r).foto, sha256: r.sha256 || null, audio: nomesDe(r).audio })), null, 2)) });
  if (comRelatorio) arqs.push({ nome: 'relatorio-fotografico.html', dados: enc.encode(html) });
  return { arqs, html };
}

// manda só o que falta: foto e áudio de registro novo (uma vez) e a tabela, o JSON e o relatório do dia (regravados na mesma pasta)
let enviando = false, esperaAte = 0;
// tipo de conexão: o Chrome do Android informa (wifi, cellular...); o iPhone não informa
function redePermitida() {
  const modo = driveCfg().rede; if (modo === 'ambos') return true;
  const t = navigator.connection && navigator.connection.type;
  if (!t || t === 'unknown') return false; // não dá para confirmar o tipo: espera
  if (modo === 'wifi') return t === 'wifi' || t === 'ethernet';
  return t === 'cellular';
}
async function estadoEnvio() {
  const cfg = driveCfg(), pend = (await lerTodos()).filter(pendente).length;
  let t = '';
  if (!cfg.url || !cfg.senha) t = 'Configure o Drive em Mais opções para enviar.';
  else if (!pend) t = '';
  else if (!navigator.onLine) t = 'Sem internet. O envio é automático quando voltar.';
  else if (!cfg.auto) t = 'Envio automático desligado. Toque para enviar.';
  else if (!redePermitida()) t = cfg.rede === 'wifi' ? 'Esperando Wi-Fi para enviar.' : 'Esperando dados móveis para enviar.';
  else if (enviando) t = 'Enviando...';
  else t = 'Envio automático ligado.';
  $('envio-status').textContent = t;
}
async function enviarPendentes(auto) {
  if (enviando) return;
  if (auto && (Date.now() < esperaAte || !redePermitida())) { estadoEnvio(); return; }
  const cfg = driveCfg();
  if (!cfg.url || !cfg.senha) { if (!auto) { carregarDrive(); mostrar('tela-exportar'); toast('Preencha o endereço e a senha do Drive e toque em Testar conexão.', 7000); } return; }
  if (!navigator.onLine) { if (!auto) toast('Sem internet. Tente de novo quando houver sinal.', 6000); return; }
  const todos = await lerTodos(), pend = todos.filter(pendente);
  if (!pend.length) { if (!auto) toast('Não há nada pendente. Tudo já está no Drive.'); return; }
  enviando = true;
  const btn = $('btn-enviar'); btn.disabled = true;
  const meta = { obra: localStorage.getItem('obra') || '', resp: localStorage.getItem('resp') || '' };
  const falhas = []; let motivo = '', mandados = 0;
  try {
    const sessoesTodas = await lerSessoes(), grupos = new Map();
    for (const r of todos) { const k = r.tipo === 'edificacao' ? `ed|${r.projeto}|${diaISO(r.ts)}` : (r.sessaoId || ('dia:' + diaISO(r.ts))); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(r); } // edificação: uma pasta por dia, com uma subpasta por ambiente
    for (const [chave, regs] of grupos) {
      if (!regs.some(pendente)) continue;
      const ses = sessoesTodas.find(x => x.id === chave);
      const edif = regs[0].tipo === 'edificacao';
      const obra = edif ? regs[0].projeto : (ses && ses.projeto ? ses.projeto : '');
      const pacote = seguro(obra || 'Sem projeto'); // pasta do projeto
      const pastaSessao = edif ? diaISO(regs[0].ts) : (ses ? pastaDaSessao(ses) : `${diaISO(regs[0].ts)} sem sessao`); // infraestrutura: subpasta da sessão; edificação: pasta do dia
      for (const r of regs) if (!r.sha256) { r.sha256 = await sha256(r.foto); if (r.sha256) await atualizarReg(r.id, a => { a.sha256 = r.sha256; }); } // registro antigo, sem código
      const novos = regs.filter(r => !(r.enviado && r.enviado.arquivos));
      const total = novos.reduce((n, r) => n + (r.audio ? 2 : 1), 0) + 2;
      let feitos = 0;
      const mandar = async (nome, dados, substituir) => {
        const blob = dados instanceof Blob ? dados : new Blob([dados]);
        for (let t = 0; t < 3; t++) {
          try {
            const j = await chamarDrive({ pacote, caminho: `${pastaSessao}/${nome}`, tipo: tipoDe(nome), dados: await blobB64(blob), substituir: !!substituir });
            if (j.tamanho === blob.size) { mandados++; feitos++; btn.textContent = `Enviando ${feitos} de ${total}...`; return true; }
            throw new Error('O Drive guardou o arquivo com tamanho diferente.');
          } catch (e) { motivo = e.message; await esperar(1500); }
        }
        falhas.push(nome); return false;
      };
      btn.textContent = `Enviando 0 de ${total}...`;
      for (const r of novos) {
        const n = nomesDe(r);
        let ok = await mandar(n.foto, r.foto, false);
        if (ok && r.audio) ok = await mandar(n.audio, r.audio, false);
        if (ok) await atualizarReg(r.id, a => { a.enviado = { arquivos: true, v: a.enviado ? a.enviado.v : '' }; });
      }
      const { arqs } = await montarArquivos(regs, { obra, resp: meta.resp }, false, false);
      let manifestoOk = true;
      for (const a of arqs) if (!(await mandar(a.nome, a.dados, true))) manifestoOk = false;
      if (manifestoOk) for (const r of regs) await atualizarReg(r.id, a => { if (a.enviado && a.enviado.arquivos) a.enviado.v = versaoReg(r); }); // versão que o Drive recebeu; edição feita durante o envio continua pendente
    }
  } catch (e) { motivo = e.message; }
  enviando = false; btn.disabled = false;
  if (falhas.length) esperaAte = Date.now() + 5 * 60000; // depois de uma falha, espera 5 minutos antes de tentar sozinho de novo
  await atualizarLista();
  if (falhas.length) toast(`Enviei ${mandados} arquivo(s). Falharam: ${falhas.slice(0, 3).join(', ')}${falhas.length > 3 ? '...' : ''}. ${motivo} Toque em enviar de novo.`, 12000);
  else if (!auto || mandados) toast(`Enviado para o Drive (${mandados} arquivo(s)).`, 7000);
}
$('btn-enviar').addEventListener('click', () => enviarPendentes(false));
function tentarEnvioAuto() { if (driveCfg().auto) enviarPendentes(true); estadoEnvio(); }
addEventListener('online', tentarEnvioAuto); addEventListener('offline', estadoEnvio);
if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', tentarEnvioAuto);
setInterval(() => { if (!document.hidden) tentarEnvioAuto(); }, 60000); // com o app aberto, confere a fila de minuto em minuto
setTimeout(tentarEnvioAuto, 2500); // e ao abrir

$('btn-limpar').addEventListener('click', async () => {
  const prontos = (await lerTodos()).filter(r => r.enviado && !pendente(r));
  if (!prontos.length) { toast('Nenhum registro já enviado para apagar.'); return; }
  if (!confirm(`Apagar do celular ${prontos.length} registro(s) já enviados ao Drive? Eles continuam no Drive. Aqui não dá para desfazer.`)) return;
  for (const r of prontos) await apagarReg(r.id);
  toast(`${prontos.length} registro(s) apagados do celular.`); atualizarLista();
});

// ---------- mais opções, plano B sem Drive: pacote do dia em ZIP e relatório preliminar ----------
$('btn-exportar').addEventListener('click', async () => {
  $('data-exp').value = diaISO(Date.now());
  $('obra').value = localStorage.getItem('obra') || ''; $('resp').value = localStorage.getItem('resp') || '';
  carregarDrive(); $('resultado').hidden = true; await resumo(); await preencherSessoesPdf(); mostrar('tela-exportar');
});
async function regsDoDia() { const d = $('data-exp').value; return (await lerTodos()).filter(r => diaISO(r.ts) === d); }
async function resumo() { const n = (await regsDoDia()).length; $('resumo-exp').textContent = n ? `${n} registro(s) nesta data.` : 'Nenhum registro nesta data.'; }
$('data-exp').addEventListener('change', resumo);
['obra', 'resp'].forEach(id => $(id).addEventListener('change', () => localStorage.setItem(id, $(id).value.trim())));
$('btn-voltar').addEventListener('click', () => { guardarDrive(); mostrar('tela-inicio'); });
$('btn-gerar').addEventListener('click', async () => {
  const regs = await regsDoDia(); if (!regs.length) { toast('Não há registros nesta data.'); return; }
  for (const r of regs) if (!r.sha256) { r.sha256 = await sha256(r.foto); if (r.sha256) await atualizarReg(r.id, a => { a.sha256 = r.sha256; }); }
  const meta = { obra: $('obra').value.trim(), resp: $('resp').value.trim() };
  localStorage.setItem('obra', meta.obra); localStorage.setItem('resp', meta.resp);
  $('btn-gerar').disabled = true; $('btn-gerar').textContent = 'Gerando...';
  try {
    const { arqs, html } = await montarArquivos(regs, meta, true);
    const ag = new Date(), nome = `registro-campo-${$('data-exp').value}_${pad(ag.getHours())}${pad(ag.getMinutes())}${pad(ag.getSeconds())}.zip`; // a hora no nome: cada geração é um arquivo novo
    ultimoPacote = new File([await montarZip(arqs)], nome, { type: 'application/zip' });
    if (ultimoRelatorioURL) URL.revokeObjectURL(ultimoRelatorioURL);
    ultimoRelatorioURL = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    $('msg-resultado').textContent = `Pacote pronto: ${nome} (${(ultimoPacote.size / 1048576).toFixed(1).replace('.', ',')} MB), com ${regs.length} registro(s), fotos originais, áudios, tabela em ordem de horário e relatório.`;
    $('resultado').hidden = false;
    toast('Pacote pronto. Toque em "Baixar o pacote".', 6000);
    $('resultado').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) { toast('Falha ao gerar o pacote: ' + e.message, 6000); }
  $('btn-gerar').disabled = false; $('btn-gerar').textContent = 'Gerar arquivos';
});
$('btn-baixar').addEventListener('click', () => { if (ultimoPacote) baixarArquivo(ultimoPacote); });
$('btn-relatorio').addEventListener('click', () => { if (ultimoRelatorioURL) window.open(ultimoRelatorioURL, '_blank'); });

// ---------- PDF simplificado da sessão, feito no próprio celular (fotos já carimbadas, em JPEG direto no PDF) ----------
const PDFW = 595.28, PDFH = 841.89, PDFM = 36;
const COR = { ind: '0.165 0.110 0.278', prata: '0.749 0.749 0.749', txt: '0.118 0.106 0.169', cinza: '0.400 0.400 0.478', br: '1 1 1', lilas: '0.863 0.843 0.918', nevoa: '0.945 0.937 0.965' };
const _cv = document.createElement('canvas').getContext('2d');
function larguraTxt(t, fs, negrito) { _cv.font = `${negrito ? 'bold ' : ''}100px Arial, Helvetica, sans-serif`; return _cv.measureText(t).width * fs / 100; }
function quebrar(texto, fs, max, negrito) {
  const linhas = [];
  for (const par of String(texto).split('\n')) {
    let atual = '';
    for (const pal of par.split(/\s+/).filter(Boolean)) {
      const teste = atual ? atual + ' ' + pal : pal;
      if (larguraTxt(teste, fs, negrito) <= max) atual = teste; else { if (atual) linhas.push(atual); atual = pal; }
    }
    linhas.push(atual);
  }
  return linhas;
}
const latin1 = s => { const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); o[i] = c < 256 ? c : 63; } return o; };
const pdfEsc = s => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
async function jpegInfo(blob) { const bmp = await createImageBitmap(blob); const o = { w: bmp.width, h: bmp.height, bytes: new Uint8Array(await blob.arrayBuffer()) }; if (bmp.close) bmp.close(); return o; }

// regs: registros de uma sessão, em ordem de horário; cab: { titulo, sub, rodape }; progresso(i, n) opcional
async function montarPdf(regs, cab, progresso) {
  const imagens = [];
  const addImg = async blob => { imagens.push(await jpegInfo(blob)); return imagens.length - 1; };
  const lc = document.createElement('canvas'); lc.width = 240; lc.height = 240;
  const lg = lc.getContext('2d'); lg.fillStyle = '#fff'; lg.fillRect(0, 0, 240, 240);
  lg.drawImage(await carregarSimbolo(), 12, 12, 216, 216);
  const idxLogo = await addImg(await new Promise(r => lc.toBlob(r, 'image/jpeg', 0.92)));

  const paginas = []; let pg = null, y = 0;
  const rect = (x, yTopo, w, h, rgb) => pg.ops.push(`${rgb} rg ${x.toFixed(2)} ${(PDFH - yTopo - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  const texto = (x, yBase, t, fs, negrito, rgb) => pg.ops.push(`BT /${negrito ? 'F2' : 'F1'} ${fs} Tf ${rgb} rg ${x.toFixed(2)} ${(PDFH - yBase).toFixed(2)} Td (${pdfEsc(t)}) Tj ET`);
  const imagem = (idx, x, yTopo, w, h) => { pg.usa.add(idx); pg.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(PDFH - yTopo - h).toFixed(2)} cm /Im${idx} Do Q`); };
  const nova = primeira => {
    pg = { ops: [], usa: new Set() }; paginas.push(pg);
    if (primeira) {
      rect(0, 0, PDFW, 78, COR.ind); rect(0, 78, PDFW, 2.5, COR.prata);
      texto(PDFM, 34, cab.titulo, 20, true, COR.br); texto(PDFM, 56, cab.sub, 10.5, false, COR.lilas);
      rect(PDFW - PDFM - 54, 12, 54, 54, COR.br); imagem(idxLogo, PDFW - PDFM - 51, 15, 48, 48);
      y = 98;
    } else {
      rect(0, 0, PDFW, 26, COR.ind); rect(0, 26, PDFW, 1.5, COR.prata);
      texto(PDFM, 17, cab.titulo + ' · ' + cab.sub, 8.5, false, COR.br); y = 44;
    }
  };
  nova(true);
  const maxW = PDFW - 2 * PDFM;
  const resumo = `${regs.length} registro(s) · primeiro às ${horaBR(regs[0].ts).slice(0, 5)} · último às ${horaBR(regs[regs.length - 1].ts).slice(0, 5)}`;
  texto(PDFM, y, resumo, 10, true, COR.ind); y += 18;

  for (let i = 0; i < regs.length; i++) {
    const r = regs[i]; if (progresso) progresso(i, regs.length);
    const carimbada = await reduzirBlob(r.foto, r, 1400); // JPEG com a faixa índigo; se falhar, pula a foto e avisa no texto
    const info = carimbada ? await jpegInfo(carimbada) : null;
    const retrato = !!info && info.h > info.w * 1.1; // foto em pé: imagem à esquerda e texto ao lado, para não sobrar página em branco
    const esc = info ? Math.min((retrato ? 200 : maxW) / info.w, (retrato ? 300 : 280) / info.h) : 0, iw = info ? info.w * esc : 0, ih = info ? info.h * esc : 0;
    const colW = retrato ? maxW - iw - 16 : maxW;
    const com = quebrar('Comentário: ' + (r.transcricao || 'Sem comentário'), 10, colW, false);
    const hl = quebrar(`Arquivo original: ${nomesDe(r).foto} · SHA-256: ${r.sha256 || 'não calculado'}`, 6.5, colW, false);
    const textoAlt = com.length * 12.5 + 6 + hl.length * 8.5;
    const alt = 16 + (info ? (retrato ? Math.max(ih, textoAlt) : ih + 8 + textoAlt) : 14 + textoAlt) + 16;
    if (y + alt > PDFH - 52) nova(false);
    texto(PDFM, y + 10, `Foto ${i + 1} de ${regs.length} · ${horaBR(r.ts)}`, 11, true, COR.ind); const yy = y + 16;
    let tx = PDFM, ty = yy;
    if (info) { const idx = imagens.push(info) - 1; imagem(idx, PDFM, yy, iw, ih); if (retrato) tx = PDFM + iw + 16; else ty = yy + ih + 8; }
    else { texto(PDFM, yy + 9, '(não foi possível gerar a imagem desta foto)', 9, false, COR.cinza); ty = yy + 14; }
    com.forEach((l, k) => texto(tx, ty + 10 + k * 12.5, l, 10, false, COR.txt)); ty += com.length * 12.5 + 6;
    hl.forEach((l, k) => texto(tx, ty + 6 + k * 8.5, l, 6.5, false, COR.cinza));
    y += alt;
  }
  const nota = quebrar('Sobre a inalterabilidade: a data, a hora e as coordenadas na faixa de cada foto são cópia dos metadados do arquivo original, guardado no Drive. Para conferir, compare os metadados do original (data, hora e geolocalização) e o código SHA-256 acima. O carimbo sozinho não prova que a foto não foi alterada.', 8, maxW - 16, false);
  if (y + nota.length * 10.5 + 16 > PDFH - 52) nova(false);
  rect(PDFM, y, maxW, nota.length * 10.5 + 12, COR.nevoa); nota.forEach((l, k) => texto(PDFM + 8, y + 15 + k * 10.5, l, 8, false, COR.txt));

  paginas.forEach((p, k) => { // rodapé em todas as páginas
    pg = p; rect(PDFM, PDFH - 40, maxW, 0.6, COR.prata);
    texto(PDFM, PDFH - 28, 'JOTA BARROS PROJETOS E ASSESSORIA', 7.5, true, COR.ind);
    texto(PDFM + larguraTxt('JOTA BARROS PROJETOS E ASSESSORIA', 7.5, true) + 8, PDFH - 28, cab.rodape, 7.5, false, COR.cinza);
    const pt = `Página ${k + 1} de ${paginas.length}`; texto(PDFW - PDFM - larguraTxt(pt, 7.5, false), PDFH - 28, pt, 7.5, false, COR.cinza);
  });

  // montagem do arquivo PDF
  const partes = [], offs = []; let desloc = 0;
  const grava = (...cs) => cs.forEach(c => { const b = typeof c === 'string' ? latin1(c) : c; partes.push(b); desloc += b.length; });
  const obj = (n, ...cs) => { offs[n] = desloc; grava(`${n} 0 obj\n`, ...cs, '\nendobj\n'); };
  const nImg = imagens.length, base = 5 + nImg;
  grava('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${paginas.length} /Kids [${paginas.map((_, k) => `${base + k * 2 + 1} 0 R`).join(' ')}] >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  imagens.forEach((im, k) => obj(5 + k, `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`, im.bytes, '\nendstream'));
  paginas.forEach((p, k) => {
    const cont = latin1(p.ops.join('\n'));
    obj(base + k * 2, `<< /Length ${cont.length} >>\nstream\n`, cont, '\nendstream');
    const xo = [...p.usa].map(i => `/Im${i} ${5 + i} 0 R`).join(' ');
    obj(base + k * 2 + 1, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDFW} ${PDFH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xo} >> >> /Contents ${base + k * 2} 0 R >>`);
  });
  const total = base + paginas.length * 2, xref = desloc;
  grava(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let n = 1; n < total; n++) grava(`${String(offs[n]).padStart(10, '0')} 00000 n \n`);
  grava(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(partes, { type: 'application/pdf' });
}

async function pdfDaSessao(sessaoId) {
  const ses = (await lerSessoes()).find(s => s.id === sessaoId);
  const regs = (await lerTodos()).filter(r => (r.sessaoId || '') === (sessaoId || ''));
  if (!regs.length) { toast('Esta sessão não tem fotos.'); return; }
  for (const r of regs) if (!r.sha256) { r.sha256 = await sha256(r.foto); if (r.sha256) await atualizarReg(r.id, a => { a.sha256 = r.sha256; }); }
  const projeto = ses && ses.projeto ? ses.projeto : (ses && ses.nome) || 'Sem projeto';
  const cab = { titulo: 'Relatório fotográfico de campo', sub: `${projeto}${ses && ses.nome && ses.projeto ? ' · ' + ses.nome : ''} · ${dataBR(regs[0].ts)}`, rodape: `Relatório simplificado · gerado em ${dataBR(Date.now())}` };
  const botoes = ['btn-pdf', 'btn-pdf-escolhida'].map($);
  botoes.forEach(b => { b.dataset.rotulo = b.dataset.rotulo || b.textContent; b.disabled = true; });
  try {
    const blob = await montarPdf(regs, cab, (i, n) => botoes.forEach(b => { b.textContent = `Gerando PDF ${i + 1} de ${n}...`; }));
    const nome = `Relatorio_${seguro(projeto).replace(/ /g, '_')}_${diaISO(regs[0].ts)}_${horaBR(ses ? ses.inicio : regs[0].ts).slice(0, 2)}h${horaBR(ses ? ses.inicio : regs[0].ts).slice(3, 5)}.pdf`;
    const arq = new File([blob], nome, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [arq] })) {
      try { await navigator.share({ files: [arq], title: nome }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    baixarArquivo(arq); toast(`PDF salvo no celular (${(arq.size / 1048576).toFixed(1).replace('.', ',')} MB). Procure em Downloads.`, 8000);
  } catch (e) { toast('Falha ao gerar o PDF: ' + e.message, 8000); }
  finally { botoes.forEach(b => { b.disabled = false; b.textContent = b.dataset.rotulo; }); }
}
$('btn-pdf').addEventListener('click', async () => {
  const aberta = await sessaoAberta(); const todas = await lerSessoes();
  const alvo = aberta || todas[todas.length - 1];
  if (alvo) pdfDaSessao(alvo.id);
  else { const regs = await lerTodos(); if (regs.length) pdfDaSessao(''); else toast('Ainda não há fotos.'); }
});
$('btn-pdf-escolhida').addEventListener('click', () => { const v = $('sel-pdf').value; if (v !== '') pdfDaSessao(v === '__sem' ? '' : v); });
async function preencherSessoesPdf() {
  const sel = $('sel-pdf'); sel.textContent = '';
  const todas = (await lerSessoes()).slice().reverse().slice(0, 30), regs = await lerTodos();
  for (const s of todas) { const n = regs.filter(r => r.sessaoId === s.id).length; if (!n) continue; const o = document.createElement('option'); o.value = s.id; o.textContent = `${s.projeto || 'Sem projeto'} · ${dataBR(s.inicio)} ${horaBR(s.inicio).slice(0, 5)}${s.nome ? ' · ' + s.nome : ''} (${n} foto(s))`; sel.append(o); }
  if (regs.some(r => !r.sessaoId)) { const o = document.createElement('option'); o.value = '__sem'; o.textContent = 'Registros sem sessão'; sel.append(o); }
}

// ---------- início ----------
const VERSAO_APP = 'v16';
function redeEstado() { $('estado-rede').textContent = (navigator.onLine ? 'Funciona sem internet' : 'Sem internet · tudo continua funcionando') + ' · ' + VERSAO_APP; }
addEventListener('online', redeEstado); addEventListener('offline', redeEstado);
redeEstado();
if ('serviceWorker' in navigator) {
  const tinhaSW = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // versão nova assumiu: recarrega sozinho só se o usuário estiver na tela inicial, para não perder um registro em andamento
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!tinhaSW) return;
    if (!$('tela-inicio').hidden && !gravando && !ditando) location.reload(); else toast('Nova versão disponível. Ela entra quando você voltar à tela inicial e reabrir.', 6000);
  });
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
atualizarLista();
