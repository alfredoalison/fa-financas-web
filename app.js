/* F&A Finanças - app.js */
const SUPABASE_URL = 'https://gczblziaqigyfciedvxa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_0tnbe4SkERpWhmA4S0pPGw_ozv2ksSC';
// Apenas a chave anon/publishable fica no front-end. A service role key NUNCA deve entrar aqui.
const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Servidor do bot (server.js), que lê a nota com o Gemini. Use '' se o PWA for servido pelo próprio bot.
// API_TOKEN deve ser igual à variável API_TOKEN do .env do bot.
const API_URL = 'https://SEU-BOT.onrender.com';
const API_TOKEN = 'COLOQUE_O_TOKEN_AQUI';

const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const TIPOS = ['DÉBITO', 'CRÉDITO', 'PIX', 'RECEITA'];

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
function hoje() { return new Date().toLocaleDateString('en-CA'); }

const state = {
  usuarios: [], cartoes: [], categorias: [], transacoes: [], metas: [],
  hidden: localStorage.getItem('fa_hidden') === '1',
  mes: hoje().slice(0, 7),
  view: 'inicio',
  scan: null,
  processando: false,
};

/* ---------- utilidades ---------- */
const money = (v) => state.hidden ? 'R$ ••••••' : Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const semAcento = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const brData = (iso) => String(iso || '').split('-').reverse().join('/');
const userName = (id) => (state.usuarios.find((u) => u.id === id)?.nome || '—').split(' ')[0];
const labelMes = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MESES[m - 1]} ${y}`; };

function addMonths(ym, n) {
  let [y, m] = ym.split('-').map(Number);
  m += n - 1;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12 + 1;
  return `${y}-${pad(m)}`;
}

// Mês (YYYY-MM) de vencimento da fatura que recebe a compra. Mesma regra do bot.
function calcularFatura(dataISO, diaFech, diaVenc) {
  const [y, m, d] = dataISO.split('-').map(Number);
  let fy = y, fm = m;
  if (d > diaFech) { fm++; if (fm > 12) { fm = 1; fy++; } }
  let vy = fy, vm = fm;
  if (diaVenc <= diaFech) { vm++; if (vm > 12) { vm = 1; vy++; } }
  return `${vy}-${pad(vm)}`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4500);
}

/* ---------- dados ---------- */
async function loadAll() {
  const [u, c, cat, t, m] = await Promise.all([
    db.from('usuarios').select('*').order('nome'),
    db.from('cartoes_credito').select('*').order('nome_cartao'),
    db.from('categorias').select('*').order('nome'),
    db.from('transacoes').select('*, itens_transacao(*)').order('data_transacao', { ascending: false }).limit(2000),
    db.from('metas_poupanca').select('*').order('data_limite', { ascending: true, nullsFirst: false }),
  ]);
  for (const r of [u, c, cat, t, m]) if (r.error) throw r.error;
  Object.assign(state, { usuarios: u.data, cartoes: c.data, categorias: cat.data, transacoes: t.data, metas: m.data });
}

async function refresh() {
  try { await loadAll(); } catch (e) { toast('Erro ao carregar dados: ' + (e.message || e)); }
  render();
}

/* ---------- navegação ---------- */
function setView(v) {
  state.view = v;
  document.querySelectorAll('.bottom button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  render();
  window.scrollTo(0, 0);
}

function render() {
  $('#eye-open').hidden = state.hidden;
  $('#eye-closed').hidden = !state.hidden;
  const app = $('#app');
  if (state.view === 'inicio') app.innerHTML = viewInicio();
  else if (state.view === 'faturas') app.innerHTML = viewFaturas();
  else if (state.view === 'metas') app.innerHTML = viewMetas();
  else app.innerHTML = viewEscanear();
  bindView();
}

/* ---------- INÍCIO ---------- */
function resumoMes(mes) {
  let ent = 0, sai = 0, cred = 0;
  for (const t of state.transacoes) {
    const v = Number(t.valor_total);
    if (t.tipo_pagamento === 'CRÉDITO') { if (t.fatura_mes_ano === mes) cred += v; }
    else if (t.data_transacao.startsWith(mes)) { if (t.tipo_pagamento === 'RECEITA') ent += v; else sai += v; }
  }
  return { ent, sai, cred, saldo: ent - sai };
}

const rowTx = (t) => {
  const rec = t.tipo_pagamento === 'RECEITA';
  return `<div class="row"><div><b>${esc(t.estabelecimento || '—')}</b>
    <small>${brData(t.data_transacao)} · ${esc(userName(t.usuario_id))} · ${esc(t.tipo_pagamento)}${t.parcelado ? ` · ${t.parcela_atual}/${t.parcelas_totais}` : ''}</small></div>
    <span class="${rec ? 'pos' : 'neg'}">${rec ? '+' : '-'}${money(t.valor_total)}</span></div>`;
};

function monthNav() {
  return `<div class="mes-nav"><button data-mes="-1" aria-label="Mês anterior">&lt;</button><span>${labelMes(state.mes)}</span><button data-mes="1" aria-label="Próximo mês">&gt;</button></div>`;
}

function viewInicio() {
  const r = resumoMes(state.mes);
  const recentes = state.transacoes.slice(0, 10);
  return `${monthNav()}
  <section class="card">
    <h2>SALDO GERAL</h2>
    <p class="saldo ${r.saldo >= 0 ? 'pos' : 'neg'}">${money(r.saldo)}</p>
    <div class="grid3">
      <div class="stat"><small>ENTRADAS</small><b class="pos">${money(r.ent)}</b></div>
      <div class="stat"><small>DÉBITO/PIX</small><b class="neg">${money(r.sai)}</b></div>
      <div class="stat"><small>FATURA CRÉDITO</small><b class="neg">${money(r.cred)}</b></div>
    </div>
  </section>
  <button class="btn primary block" id="novo" style="margin-bottom:16px">+ NOVO LANÇAMENTO</button>
  <section class="card">
    <h2>ÚLTIMOS LANÇAMENTOS</h2>
    ${recentes.length ? recentes.map(rowTx).join('') : '<div class="empty">Nenhum lançamento ainda. Toque em "Novo lançamento" ou envie uma foto de nota no grupo.</div>'}
  </section>`;
}

/* ---------- FATURAS ---------- */
function viewFaturas() {
  const cards = state.cartoes.map((c) => {
    const txs = state.transacoes.filter((t) => t.cartao_id === c.id && t.fatura_mes_ano === state.mes);
    const total = txs.reduce((s, t) => s + Number(t.valor_total), 0);
    const venc = `${pad(c.dia_vencimento)}/${state.mes.split('-')[1]}/${state.mes.split('-')[0]}`;
    const lista = txs.map((t) => {
      const itens = (t.itens_transacao || []);
      return `<details><summary>${rowTx(t)}</summary>
        ${itens.length ? `<div class="itens">${itens.map((i) => `<div><span>${esc(i.quantidade)}x ${esc(i.nome_produto)}</span><span>${money(i.valor_total)}</span></div>`).join('')}</div>`
          : '<div class="itens">Sem itens detalhados.</div>'}
      </details>`;
    }).join('');
    return `<section class="card">
      <div class="fatura-head"><h2 style="margin:0">${esc(c.nome_cartao).toUpperCase()}</h2><b class="neg">${money(total)}</b></div>
      <small style="color:var(--mut)">Vence em ${venc} · fecha dia ${c.dia_fechamento}</small>
      <div style="margin-top:8px">${lista || '<div class="empty">Sem compras nesta fatura.</div>'}</div>
    </section>`;
  }).join('');
  return `${monthNav()}${cards || '<div class="empty">Nenhum cartão cadastrado.</div>'}`;
}

/* ---------- METAS ---------- */
function viewMetas() {
  const cards = state.metas.map((m) => {
    const alvo = Number(m.valor_alvo), atual = Number(m.valor_atual);
    const pct = Math.min(100, alvo ? (atual / alvo) * 100 : 0);
    const resta = Math.max(0, alvo - atual);
    return `<section class="card">
      <div class="fatura-head"><h2 style="margin:0">${esc(m.nome_meta).toUpperCase()}</h2><b class="pos">${pct.toFixed(0)}%</b></div>
      <div class="bar" role="progressbar" aria-valuenow="${pct.toFixed(0)}" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:${pct}%"></div></div>
      <div class="meta-info"><span>${money(atual)} de ${money(alvo)}</span><span>Faltam ${money(resta)}</span></div>
      ${m.data_limite ? `<div class="meta-info" style="margin-top:4px"><span>Prazo: ${brData(m.data_limite)}</span></div>` : ''}
      <div class="meta-actions">
        <button class="btn primary" data-dep="${m.id}">+ DEPOSITAR</button>
        <button class="btn danger" data-del="${m.id}">EXCLUIR</button>
      </div>
    </section>`;
  }).join('');
  return `<button class="btn primary block" id="nova-meta" style="margin-bottom:16px">+ NOVA CAIXINHA</button>
    ${cards || '<div class="empty">Nenhuma caixinha criada. Crie uma meta para começar a poupar.</div>'}`;
}

/* ---------- ESCANEAR (foto/PDF de nota ou comprovante) ---------- */
function viewEscanear() {
  const sc = state.scan;
  const corpo = sc
    ? `<div class="preview">${sc.isPdf
        ? `<div class="preview-pdf">📄<small>${esc(sc.nome)}</small></div>`
        : `<img src="${esc(sc.url)}" alt="Pré-visualização da nota">`}</div>
      <button class="btn primary block" id="scan-go"${state.processando ? ' disabled' : ''}>${state.processando ? 'PROCESSANDO...' : 'PROCESSAR E EXTRAIR DADOS'}</button>
      <button class="btn block" id="scan-redo" style="margin-top:8px"${state.processando ? ' disabled' : ''}>TIRAR OUTRA FOTO</button>`
    : `<div class="scan-btns">
        <button class="btn primary" id="scan-cam">📷 TIRAR FOTO</button>
        <button class="btn" id="scan-gal">📁 SELECIONAR DA GALERIA</button>
      </div>`;
  return `<section class="card">
    <h2>CAPTURAR OU ENVIAR NOTA/COMPROVANTE</h2>
    <p class="scan-desc">Tire uma foto legível do cupom, fatura, conta de água ou recibo para extrair os dados automaticamente.</p>
    ${corpo}
    <input type="file" id="in-cam" accept="image/*" capture="environment" hidden>
    <input type="file" id="in-gal" accept="image/*,application/pdf" hidden>
  </section>
  <section class="card">
    <h2>PREFERE DIGITAR?</h2>
    <button class="btn block" id="novo">LANÇAR MANUALMENTE</button>
  </section>`;
}

function limparScan() {
  if (state.scan?.url) URL.revokeObjectURL(state.scan.url);
  state.scan = null;
  state.processando = false;
}

function escolherArquivo(file) {
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf && !String(file.type).startsWith('image/')) return toast('Escolha uma foto ou um arquivo PDF.');
  if (file.size > 25 * 1024 * 1024) return toast('Arquivo muito grande (máx. 25 MB).');
  limparScan();
  state.scan = { file, isPdf, nome: file.name || 'comprovante.pdf', url: isPdf ? null : URL.createObjectURL(file) };
  render();
}

function bindScan() {
  const cam = $('#in-cam'), gal = $('#in-gal');
  if (!cam || !gal) return;
  const pegar = (inp) => () => { const f = inp.files[0]; inp.value = ''; escolherArquivo(f); };
  cam.onchange = pegar(cam);
  gal.onchange = pegar(gal);
  const bc = $('#scan-cam'); if (bc) bc.onclick = () => cam.click();
  const bg = $('#scan-gal'); if (bg) bg.onclick = () => gal.click();
  const br = $('#scan-redo'); if (br) br.onclick = () => cam.click(); // o preview atual é trocado ao tirar a nova foto
  const go = $('#scan-go'); if (go) go.onclick = processarScan;
}

// Reduz a foto (lado maior 1800 px, JPEG) para o envio ser rápido no 4G. PDF segue como está.
async function arquivoParaEnvio(file, isPdf) {
  if (isPdf) return { mime: 'application/pdf', blob: file };
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
    if (blob) return { mime: 'image/jpeg', blob };
  } catch (_) { /* formato que o navegador não decodifica: envia o original */ }
  return { mime: file.type || 'image/jpeg', blob: file };
}

const blobParaBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(new Error('Não consegui ler o arquivo.'));
  r.readAsDataURL(blob);
});

async function processarScan() {
  const sc = state.scan;
  if (!sc || state.processando) return;
  if (API_URL.includes('SEU-BOT') || API_TOKEN.includes('COLOQUE')) {
    return toast('Configure API_URL e API_TOKEN no topo do app.js para extrair os dados.');
  }
  state.processando = true;
  render();
  try {
    const { mime, blob } = await arquivoParaEnvio(sc.file, sc.isPdf);
    if (blob.size > 12 * 1024 * 1024) throw new Error('Arquivo muito grande para enviar (máx. 12 MB). Tire a foto de novo.');
    const resp = await fetch(`${API_URL}/api/extrair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fa-token': API_TOKEN },
      body: JSON.stringify({ mime, data: await blobParaBase64(blob) }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(json.erro || `Erro ${resp.status} ao extrair os dados.`);
    limparScan();
    render();
    abrirLancamentoExtraido(json);
  } catch (e) {
    state.processando = false;
    render();
    toast(e instanceof TypeError ? 'Não consegui falar com o servidor do bot. Confira a internet e o API_URL.' : (e.message || String(e)));
  }
}

function abrirLancamentoExtraido(n) {
  const tipo = n.tipo_documento === 'pix_recebido' ? 'RECEITA' : n.tipo_documento === 'pix_enviado' ? 'PIX' : 'DÉBITO';
  const cat = state.categorias.find((c) => semAcento(c.nome) === semAcento(n.categoria));
  openTxModal({
    titulo: 'CONFIRMAR DADOS EXTRAÍDOS',
    estab: n.estabelecimento, valor: Number(n.valor_total) || 0, data: n.data,
    tipo, categoriaId: cat?.id, itens: n.itens || [],
  });
}

/* ---------- Modais ---------- */
function openModal(title, bodyHtml, onSubmit) {
  const el = document.createElement('div');
  el.className = 'modal-bg';
  el.innerHTML = `<form class="modal"><div class="modal-h"><b>${esc(title)}</b><button type="button" class="x" aria-label="Fechar">X</button></div>
    ${bodyHtml}
    <div class="actions"><button type="button" class="btn x">CANCELAR</button><button class="btn primary">SALVAR</button></div></form>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelectorAll('.x').forEach((b) => (b.onclick = close));
  const form = $('form', el);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await onSubmit(new FormData(form)); close(); await refresh(); }
    catch (err) { toast(err.message || String(err)); }
  };
  return { el, form, close };
}

const optionsHtml = (arr, label, sel) => arr.map((o) => `<option value="${esc(o.id)}"${o.id === sel ? ' selected' : ''}>${esc(o[label])}</option>`).join('');

function openTxModal(pre = {}) {
  const lastUser = meuId() || localStorage.getItem('fa_user');
  const { el } = openModal(pre.titulo || 'NOVO LANÇAMENTO', `
    <div class="field"><label>TIPO</label><select name="tipo">${TIPOS.map((t) => `<option>${t}</option>`).join('')}</select></div>
    <div class="field"><label>QUEM</label><select name="usuario">${optionsHtml(state.usuarios, 'nome', lastUser)}</select></div>
    <div class="field"><label>VALOR TOTAL (R$)</label><input name="valor" inputmode="decimal" placeholder="0,00" value="${pre.valor ? pre.valor.toFixed(2).replace('.', ',') : ''}" required></div>
    <div class="field cred hidden"><label>CARTÃO</label><select name="cartao">${optionsHtml(state.cartoes, 'nome_cartao')}</select></div>
    <div class="field cred hidden"><label>PARCELAS</label><input name="parcelas" type="number" min="1" max="24" value="1"></div>
    <div class="field cat"><label>CATEGORIA</label><div class="inline"><select name="categoria">${optionsHtml(state.categorias, 'nome', pre.categoriaId)}</select><button type="button" class="btn" id="nova-cat">+ NOVA</button></div></div>
    <div class="field"><label>ESTABELECIMENTO / DESCRIÇÃO</label><input name="estab" value="${esc(pre.estab || '')}"></div>
    <div class="field"><label>DATA</label><input name="data" type="date" value="${pre.data || hoje()}" required></div>
    ${pre.itens?.length ? `<div class="field"><small style="color:var(--mut)">${pre.itens.length} ITEM(NS) DA NOTA SERÃO ANEXADOS</small></div>` : ''}`,
  async (fd) => {
    const tipo = fd.get('tipo');
    const valor = parseFloat(String(fd.get('valor')).replace(/\./g, '').replace(',', '.')) || parseFloat(String(fd.get('valor')).replace(',', '.'));
    if (!(valor > 0)) throw new Error('Informe um valor maior que zero.');
    const data = fd.get('data');
    const base = {
      usuario_id: fd.get('usuario'),
      tipo_pagamento: tipo,
      categoria_id: tipo === 'RECEITA' ? null : (fd.get('categoria') || null),
      estabelecimento: (fd.get('estab') || '').trim() || null,
      data_transacao: data,
    };
    localStorage.setItem('fa_user', base.usuario_id);
    const rows = [];
    if (tipo === 'CRÉDITO') {
      const cartao = state.cartoes.find((c) => c.id === fd.get('cartao'));
      if (!cartao) throw new Error('Escolha um cartão.');
      const n = Math.max(1, parseInt(fd.get('parcelas'), 10) || 1);
      const fat = calcularFatura(data, cartao.dia_fechamento, cartao.dia_vencimento);
      const cents = Math.round(valor * 100), parte = Math.floor(cents / n);
      for (let i = 0; i < n; i++) {
        const c = i === n - 1 ? cents - parte * (n - 1) : parte;
        rows.push({ ...base, cartao_id: cartao.id, fatura_mes_ano: addMonths(fat, i), valor_total: c / 100, parcelado: n > 1, parcela_atual: i + 1, parcelas_totais: n });
      }
    } else {
      rows.push({ ...base, valor_total: valor, parcelado: false });
    }
    const { data: inseridas, error } = await db.from('transacoes').insert(rows).select('id,parcela_atual');
    if (error) throw error;
    if (pre.itens?.length) { // itens ficam na primeira parcela (ou na única transação)
      const prim = inseridas.find((t) => (t.parcela_atual || 1) === 1) || inseridas[0];
      const { error: errItens } = await db.from('itens_transacao').insert(pre.itens.map((i) => ({
        transacao_id: prim.id, nome_produto: i.nome_produto, quantidade: i.quantidade,
        valor_unitario: i.valor_unitario, valor_total: i.valor_total,
      })));
      if (errItens) throw errItens;
    }
  });

  const sel = $('[name=tipo]', el);
  const toggle = () => {
    el.querySelectorAll('.cred').forEach((f) => f.classList.toggle('hidden', sel.value !== 'CRÉDITO'));
    $('.cat', el).classList.toggle('hidden', sel.value === 'RECEITA');
  };
  if (pre.tipo) sel.value = pre.tipo;
  sel.onchange = toggle;
  toggle();

  $('#nova-cat', el).onclick = async () => {
    const nome = (prompt('Nome da nova categoria:') || '').trim();
    if (!nome) return;
    const { data, error } = await db.from('categorias').insert({ nome }).select().single();
    if (error) return toast(error.message);
    state.categorias.push(data);
    const s = $('[name=categoria]', el);
    s.insertAdjacentHTML('beforeend', `<option value="${esc(data.id)}">${esc(data.nome)}</option>`);
    s.value = data.id;
  };
}

function openMetaModal() {
  openModal('NOVA CAIXINHA', `
    <div class="field"><label>NOME DA META</label><input name="nome" required></div>
    <div class="field"><label>VALOR ALVO (R$)</label><input name="alvo" inputmode="decimal" required></div>
    <div class="field"><label>JÁ GUARDADO (R$)</label><input name="atual" inputmode="decimal" value="0"></div>
    <div class="field"><label>DATA LIMITE (OPCIONAL)</label><input name="limite" type="date"></div>`,
  async (fd) => {
    const num = (v) => parseFloat(String(v).replace(/\./g, '').replace(',', '.')) || 0;
    const alvo = num(fd.get('alvo'));
    if (!(alvo > 0)) throw new Error('O valor alvo precisa ser maior que zero.');
    const { error } = await db.from('metas_poupanca').insert({
      nome_meta: fd.get('nome').trim(), valor_alvo: alvo, valor_atual: num(fd.get('atual')), data_limite: fd.get('limite') || null,
    });
    if (error) throw error;
  });
}

function openDepositModal(id) {
  const meta = state.metas.find((m) => m.id === id);
  if (!meta) return;
  openModal(`DEPOSITAR EM ${meta.nome_meta.toUpperCase()}`, `
    <div class="field"><label>VALOR (R$)</label><input name="valor" inputmode="decimal" required></div>`,
  async (fd) => {
    const v = parseFloat(String(fd.get('valor')).replace(/\./g, '').replace(',', '.'));
    if (!(v > 0)) throw new Error('Informe um valor maior que zero.');
    const { error } = await db.from('metas_poupanca').update({ valor_atual: Number(meta.valor_atual) + v }).eq('id', id);
    if (error) throw error;
  });
}

/* ---------- eventos ---------- */
function bindView() {
  document.querySelectorAll('[data-mes]').forEach((b) => (b.onclick = () => { state.mes = addMonths(state.mes, Number(b.dataset.mes)); render(); }));
  const novo = $('#novo'); if (novo) novo.onclick = () => openTxModal();
  const nm = $('#nova-meta'); if (nm) nm.onclick = openMetaModal;
  document.querySelectorAll('[data-dep]').forEach((b) => (b.onclick = () => openDepositModal(b.dataset.dep)));
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Excluir esta caixinha?')) return;
    const { error } = await db.from('metas_poupanca').delete().eq('id', b.dataset.del);
    if (error) toast(error.message); else refresh();
  }));
  bindScan();
}

document.querySelectorAll('.bottom button').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
$('#eye').onclick = () => {
  state.hidden = !state.hidden;
  localStorage.setItem('fa_hidden', state.hidden ? '1' : '0');
  render();
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
/* ---------- LOGIN (CPF + senha de 6 dígitos) ---------- */
// Os CPFs e senhas NÃO ficam em texto puro: só o hash SHA-256 de cada um.
// Cadastro: sha256("fa-financas:" + cpf)  e  sha256("fa-financas:" + cpf + ":" + senha)
const AUTH = {
  users: {
    'f00daf346ffece9efb262d4abad4f928c7b3bcc54f944642dd2677ec825dfb19': {
      nome: 'Alfredo Alison', saudacao: 'Bem-vindo',
      cred: 'ed30009534baad6541ba500f13b6f737d5050c2ed0d3bff15503f1a28cf35fd9',
    },
    '1a9aef70d972f0fb6162465715135ab5aadeedd19636e08102cae39847cd3fcf': {
      nome: 'Fernanda Regina', saudacao: 'Bem-vinda',
      cred: '7962ddba3fa55595174378517c2b972c4ce04d8785e8a5c3e2f4fb65895d9f60',
    },
  },
  maxTentativas: 5,
  bloqueioMs: 60000,
};

const sha256 = async (txt) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};
const soDigitos = (v) => String(v || '').replace(/\D/g, '');
const hashCpf = (cpf) => sha256('fa-financas:' + cpf);
const hashCred = (cpf, senha) => sha256('fa-financas:' + cpf + ':' + senha);

function maskCpf(v) {
  return soDigitos(v).slice(0, 11)
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

const session = { user: null };
function meuId() {
  const nome = session.user?.nome;
  return nome ? state.usuarios.find((u) => u.nome === nome)?.id : null;
}

let cpfToken = 0;
async function reconhecerCpf() {
  const msg = $('#login-msg');
  const cpf = soDigitos($('#cpf').value);
  const token = ++cpfToken;
  msg.className = 'login-msg';
  msg.textContent = '';
  if (cpf.length < 11) return null;
  const k = await hashCpf(cpf);
  if (token !== cpfToken) return null; // digitação mais nova já em andamento
  const user = AUTH.users[k];
  if (!user) { msg.classList.add('bad'); msg.textContent = 'CPF não autorizado'; return null; }
  msg.classList.add('ok');
  msg.textContent = `${user.saudacao}, ${user.nome}`;
  return { k, user, cpf };
}

function lockedUntil() { return Number(localStorage.getItem('fa_lock') || 0); }

async function tentarLogin(e) {
  e.preventDefault();
  const err = $('#login-err');
  err.textContent = '';
  const agora = Date.now();
  if (lockedUntil() > agora) {
    err.textContent = `MUITAS TENTATIVAS. AGUARDE ${Math.ceil((lockedUntil() - agora) / 1000)}s.`;
    return;
  }
  const r = await reconhecerCpf();
  const senha = soDigitos($('#senha').value);
  if (!r) { err.textContent = 'INFORME UM CPF AUTORIZADO.'; return; }
  if (senha.length !== 6) { err.textContent = 'A SENHA TEM 6 DÍGITOS.'; return; }
  const cred = await hashCred(r.cpf, senha);
  if (cred !== r.user.cred) {
    const n = Number(localStorage.getItem('fa_fail') || 0) + 1;
    if (n >= AUTH.maxTentativas) {
      localStorage.setItem('fa_lock', String(Date.now() + AUTH.bloqueioMs));
      localStorage.setItem('fa_fail', '0');
      err.textContent = 'MUITAS TENTATIVAS. AGUARDE 60s.';
    } else {
      localStorage.setItem('fa_fail', String(n));
      err.textContent = 'SENHA INCORRETA.';
    }
    $('#senha').value = '';
    return;
  }
  localStorage.setItem('fa_fail', '0');
  localStorage.setItem('fa_session', JSON.stringify({ k: r.k, c: cred }));
  entrar(r.user);
}

function entrar(user) {
  session.user = user;
  document.body.classList.remove('locked');
  $('#login-form').reset();
  $('#login-msg').textContent = '';
  $('#login-err').textContent = '';
  setView('inicio');
  refresh();
}

function sair() {
  limparScan();
  document.querySelectorAll('.modal-bg').forEach((m) => m.remove());
  localStorage.removeItem('fa_session');
  session.user = null;
  Object.assign(state, { usuarios: [], cartoes: [], categorias: [], transacoes: [], metas: [] });
  $('#app').innerHTML = '';
  document.body.classList.add('locked');
  window.scrollTo(0, 0);
  $('#cpf').focus();
}

function sessaoSalva() {
  try {
    const s = JSON.parse(localStorage.getItem('fa_session') || 'null');
    const user = s && AUTH.users[s.k];
    return user && user.cred === s.c ? user : null; // valida contra o cadastro atual
  } catch (_) { return null; }
}

function initAuth() {
  $('#cpf').addEventListener('input', (e) => { e.target.value = maskCpf(e.target.value); reconhecerCpf(); });
  $('#senha').addEventListener('input', (e) => { e.target.value = soDigitos(e.target.value).slice(0, 6); });
  $('#login-form').addEventListener('submit', tentarLogin);
  $('#logout').onclick = sair;
  const user = sessaoSalva();
  if (user) entrar(user);
  else { localStorage.removeItem('fa_session'); $('#cpf').focus(); }
}

initAuth();
