/* =====================================================================
   Belor — Painel da Loja (PWA)
   Lê a planilha "Vendas Phibo (Belor)" pelo receptor do Google Apps Script.
   Sem dependências externas. Só totais da loja — nenhum dado de cliente.
   ===================================================================== */
(function () {
'use strict';

/* ---------------- configuração ---------------- */
const API_PADRAO = 'https://script.google.com/macros/s/AKfycbwp29On9-npjl4QyiiJ_Q9g6tIKjmwTbdtq05uGk4D06_VR12A6xAeZpVHZRnH8UVGN/exec';
const BOLETIM_URL = 'https://claude.ai/artifact/ToAKhvVxycLAc4N1jP56du';
const TZ = 'America/Sao_Paulo';
const VERSAO = '1.2.0';
const METAS_PADRAO = {
  meta_mes: 100000,     // faturamento do mês (R$)
  ticket: 200,          // ticket médio alvo (R$)
  pa: 2.6,              // peças por atendimento
  cadastro: 0.90,       // % das vendas com cliente cadastrado
  desconto_max: 0.06,   // desconto máximo sobre o valor cheio
  cpf_max: 0.80,        // custo por seguidor (anúncio BH)
  venda_por_real: 40,   // R$ de venda da loja por R$ 1 de anúncio
  seg_ig_dia: 60        // seguidores novos por dia no Instagram
};
// Feriados nacionais (loja fechada): só afetam o cálculo da meta por dia.
const FERIADOS = new Set(['2026-10-12','2026-11-02','2026-11-20','2026-12-25','2027-01-01','2027-04-02','2027-04-21','2027-05-01','2027-09-07','2027-10-12','2027-11-02','2027-11-15','2027-11-20','2027-12-25']);

/* ---------------- estado ---------------- */
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const qs = new URLSearchParams(location.search);
const S = {
  api: qs.get('api') || ls.get('belor_api', API_PADRAO),
  pin: qs.get('pin') || ls.get('belor_pin', null),
  data: ls.get('belor_cache', null),
  tab: qs.get('tab') || ls.get('belor_tab', 'hoje'),
  periodo: ls.get('belor_periodo', 'mes'),
  metasLocais: ls.get('belor_metas', {}),
  oculto: ls.get('belor_oculto', false),
  somOn: ls.get('belor_som', true),
  loading: false, erro: null, ultimaBusca: 0, abertos: {}
};
if (qs.get('pin')) ls.set('belor_pin', qs.get('pin'));

/* ---------------- utilidades ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => (v === '' || v == null || isNaN(+v)) ? null : +v;
const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const OCULTO = () => !!S.oculto, MASK = '••••';
const brl = v => v == null ? '—' : 'R$ ' + (OCULTO() ? MASK : nf2.format(v));
const brl0 = v => v == null ? '—' : 'R$ ' + (OCULTO() ? MASK : nf0.format(Math.round(v)));
const brlK = v => { if (v == null) return '—'; if (OCULTO()) return 'R$ ' + MASK; const a = Math.abs(v); if (a >= 1e6) return 'R$ ' + nf1.format(v / 1e6) + ' mi'; if (a >= 1e4) return 'R$ ' + nf1.format(v / 1e3) + ' mil'; return brl0(v); };
const pct = (v, d = 0) => v == null ? '—' : (OCULTO() ? '••' : d ? nf1.format(v * 100) : nf0.format(Math.round(v * 100))) + '%';
const dec1 = v => v == null ? '—' : OCULTO() ? '••' : nf1.format(v);
const dec2 = v => v == null ? '—' : OCULTO() ? '••' : nf2.format(v);
const qtd = v => v == null ? '—' : OCULTO() ? '••' : nf0.format(v);
// texto livre (boletim, diagnóstico): troca os números por •• sem estragar entidades HTML
const mascara = t => (t == null || !OCULTO()) ? t : String(t).replace(/&#?\w+;|R\$\s?\d[\d.,]*|\d[\d.,]*/g, m => m[0] === '&' ? m : m.startsWith('R$') ? 'R$ ••' : '••');
const sum = (a, f) => a.reduce((s, x) => s + (num(f(x)) || 0), 0);
const MES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const DSEM = ['dom','seg','ter','qua','qui','sex','sáb'];
const DSEML = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function hojeISO() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
function agoraSP() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(new Date());
  const h = +p.find(x => x.type === 'hour').value % 24, m = +p.find(x => x.type === 'minute').value;
  return { min: h * 60 + m, dow: new Date(hojeISO() + 'T12:00:00Z').getUTCDay() };
}
const ymd = iso => { const [y, m, d] = iso.split('-').map(Number); return { y, m, d }; };
const dowOf = iso => new Date(iso + 'T12:00:00Z').getUTCDay();
const addDias = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diasNoMes = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isoDe = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lojaAbre = iso => dowOf(iso) !== 0 && !FERIADOS.has(iso);
const ddmm = iso => iso.slice(8, 10) + '/' + iso.slice(5, 7);
function horaDe(isoTs) {
  if (!isoTs) return null;
  const d = new Date(String(isoTs).split(' ')[0]);
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(d);
}
function minutosDesde(isoTs) {
  if (!isoTs) return null;
  const d = new Date(String(isoTs).split(' ')[0]);
  return isNaN(d) ? null : Math.round((Date.now() - d.getTime()) / 60000);
}
const durTxt = m => m == null ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;

/* ---------------- dados ---------------- */
function normalizar(j) {
  const linhas = (j.vendas || j.linhas || []).map(r => {
    const o = { data: String(r.data).slice(0, 10) };
    for (const k of ['faturamento','vendas','pecas','ticket','pa','sem_cad_vendas','sem_cad_valor','descontos','pix','dinheiro','credito','debito','outras_formas','mes_faturamento','mes_vendas']) o[k] = num(r[k]);
    o.detalhe = r.detalhe === 'completo';
    o.vend = {};
    if (r.vend && typeof r.vend === 'object') for (const nome in r.vend) { const v = num(r.vend[nome]); if (v != null) o.vend[nome] = v; }
    return o;
  }).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.data)).sort((a, b) => a.data < b.data ? -1 : 1);
  return {
    recebido: new Date().toISOString(),
    ultimo_envio: j.ultimo_envio || null,
    vendas: linhas,
    config: Object.assign({}, j.config || {}),
    boletim: j.boletim || null,
    boletins: j.boletins || [],
    anuncios: (j.anuncios || []).map(a => ({ data: String(a.data).slice(0, 10), gasto: num(a.gasto), seguidores: num(a.seguidores), visitas: num(a.visitas), conversas: num(a.conversas), cliques: num(a.cliques), impressoes: num(a.impressoes) })),
    instagram: (j.instagram || []).map(a => ({ data: String(a.data).slice(0, 10), saldo: num(a.saldo), alcance: num(a.alcance), total: num(a.total) })),
    clientes: (j.clientes || []).map(r => {
      let o = {}; try { o = JSON.parse(r.cad_origens || '{}') || {}; } catch (e) { o = {}; }
      return { data: String(r.data).slice(0, 10), novos: num(r.cad_novos), origens: o, voltaram: num(r.voltaram_mes), compraram: num(r.compraram_mes), base: num(r.base_total), vendasMes: num(r.vendas_mes), semCadMes: num(r.sem_cad_mes) };
    }).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.data)).sort((a, b) => a.data < b.data ? -1 : 1),
    push: j.push || null,
    diagnostico: j.diagnostico || null,
    fatos: (j.textos && j.textos.fatos) || {},
    versao_servidor: j.versao || 1
  };
}
function metas() {
  const M = Object.assign({}, METAS_PADRAO, (S.data && S.data.config) || {});
  const L = S.metasLocais || {};
  if (L.mes === hojeISO().slice(0, 7)) Object.assign(M, L.valores || {}); // ajuste feito aqui e ainda não confirmado pelo servidor
  return M;
}
const fato = id => (S.data && S.data.fatos && S.data.fatos[id]) ? `<div class="fato">${mascara(S.data.fatos[id])}</div>` : '';

async function buscar(pin, silencioso) {
  if (S.loading) return;
  S.loading = true; if (!silencioso) atualizarBotaoSync();
  try {
    const url = `${S.api}${S.api.includes('?') ? '&' : '?'}k=${encodeURIComponent(pin)}&acao=app&dias=95&t=${Date.now()}`;
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 25000);
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store', redirect: 'follow' });
    clearTimeout(to);
    const j = await r.json();
    if (!j.ok) throw new Error(j.erro === 'chave' ? 'chave' : (j.erro || 'erro'));
    S.data = normalizar(j); S.erro = null; S.ultimaBusca = Date.now();
    ls.set('belor_cache', S.data);
    checarVendaNova();
    return true;
  } catch (e) {
    S.erro = e.message === 'chave' ? 'chave' : 'rede';
    return false;
  } finally {
    S.loading = false; atualizarBotaoSync();
  }
}

/* ---------------- motor de métricas ---------------- */
function linhaDe(iso) { return (S.data && S.data.vendas.find(r => r.data === iso)) || null; }
function diasAbertosMes(y, m) { let n = 0; for (let d = 1; d <= diasNoMes(y, m); d++) if (lojaAbre(isoDe(y, m, d))) n++; return n; }

function agregar(rows) {
  const det = rows.filter(r => r.detalhe);                                   // dias com o painel completo
  const comPecas = rows.filter(r => r.pecas != null && (r.vendas || 0) > 0);  // dias com peças (painel ou varredura)
  const a = {
    n: rows.length,
    fat: sum(rows, r => r.faturamento), vendas: sum(rows.filter(r => r.vendas != null), r => r.vendas),
    vendasConhecidas: rows.filter(r => (r.faturamento || 0) > 0).every(r => r.vendas != null),
    fatComVendas: sum(rows.filter(r => r.vendas != null), r => r.faturamento),
    detFat: sum(det, r => r.faturamento), detVendas: sum(det, r => r.vendas),
    pecas: sum(comPecas, r => r.pecas), pecasVendas: sum(comPecas, r => r.vendas), pecasFat: sum(comPecas, r => r.faturamento),
    semcadV: sum(det, r => r.sem_cad_vendas), semcadValor: sum(det, r => r.sem_cad_valor), descontos: sum(det, r => r.descontos),
    pix: sum(det, r => r.pix), dinheiro: sum(det, r => r.dinheiro), credito: sum(det, r => r.credito), debito: sum(det, r => r.debito), outras: sum(det, r => r.outras_formas),
    vend: det.reduce((o, r) => { for (const k in (r.vend || {})) o[k] = (o[k] || 0) + (r.vend[k] || 0); return o; }, {}),
    temDet: det.length > 0 && sum(det, r => r.vendas) > 0, nDet: det.length, diasDet: det.filter(r => (r.vendas || 0) > 0).length,
    temPecas: comPecas.length > 0, diasPecas: comPecas.length,
    diasVenda: rows.filter(r => (r.faturamento || 0) > 0).length
  };
  a.ticket = a.vendas ? a.fatComVendas / a.vendas : null;
  a.pa = a.pecasVendas ? a.pecas / a.pecasVendas : null;
  a.precoPeca = a.pecas ? a.pecasFat / a.pecas : null;
  a.cadastro = a.detVendas ? 1 - a.semcadV / a.detVendas : null;
  a.descPct = (a.detFat + a.descontos) > 0 && a.temDet ? a.descontos / (a.detFat + a.descontos) : null;
  return a;
}

function contexto(periodo) {
  const hoje = hojeISO(), { y, m, d } = ymd(hoje), M = metas();
  const vendas = (S.data && S.data.vendas) || [];
  const abMes = diasAbertosMes(y, m);
  const metaDia = M.meta_mes / abMes;
  let ini;
  if (periodo === 'hoje') ini = hoje;
  else if (periodo === '7d') ini = addDias(hoje, -6);
  else ini = isoDe(y, m, 1);
  const rows = vendas.filter(r => r.data >= ini && r.data <= hoje);
  const completos = rows.filter(r => r.data < hoje);
  let diasCompletos = 0; for (let i = ini; i < hoje; i = addDias(i, 1)) if (lojaAbre(i)) diasCompletos++;
  const hojeAbre = lojaAbre(hoje);
  const ag = agregar(rows), agC = agregar(completos);
  const porDia = periodo === 'hoje'
    ? { fat: ag.fat, vendas: ag.vendas }
    : { fat: diasCompletos ? agC.fat / diasCompletos : null, vendas: diasCompletos ? agC.vendas / diasCompletos : null };
  // anúncios (campanhas da loja BH)
  const ads = ((S.data && S.data.anuncios) || []).filter(r => r.data >= ini && r.data <= hoje);
  const adsG = sum(ads, r => r.gasto), adsS = sum(ads, r => r.seguidores);
  const fatComAds = sum(rows.filter(r => ads.some(a => a.data === r.data)), r => r.faturamento);
  const ig = ((S.data && S.data.instagram) || []).filter(r => r.data >= ini && r.data <= hoje && r.saldo != null);
  return {
    periodo, hoje, y, m, d, M, abMes, metaDia, rows, ag, agC, porDia, diasCompletos, hojeAbre, ini,
    ads: { n: ads.length, gasto: adsG, seguidores: adsS, cpf: adsS ? adsG / adsS : null, porDia: ads.length ? adsG / ads.length : null, vendaPorReal: adsG ? fatComAds / adsG : null, conversas: sum(ads, r => r.conversas) },
    ig: { n: ig.length, porDia: ig.length ? sum(ig, r => r.saldo) / ig.length : null }
  };
}

function status(v, meta, dir) {
  if (v == null || meta == null) return 'na';
  const r = dir === 'down' ? (v > 0 ? meta / v : 9) : v / meta;
  return r >= 1 ? 'good' : r >= 0.85 ? 'warn' : 'bad';
}

/* definição dos microdados */
function microdados(c) {
  const M = c.M, a = c.ag, p = c.porDia;
  const ticketMeta = M.ticket, vendasMeta = c.metaDia / ticketMeta;
  const per = c.periodo === 'hoje' ? 'hoje' : c.periodo === '7d' ? 'nos últimos 7 dias' : 'no mês';
  const baseDe = n => c.periodo !== 'hoje' && n && n < a.diasVenda ? ` · base: ${n} ${n === 1 ? 'dia' : 'dias'} com detalhe` : '';
  const base = baseDe(a.diasDet), baseP = baseDe(a.diasPecas);
  const L = [];
  L.push({ g: 'Resultado', id: 'fatdia', nome: c.periodo === 'hoje' ? 'Faturamento de hoje' : 'Faturamento por dia', desc: c.periodo === 'hoje' ? 'Vendido hoje x meta do dia' : 'Média dos dias de loja já fechados', v: p.fat, meta: c.metaDia, fmt: brl0, dir: 'up',
    dica: `A meta de <b>${brl0(M.meta_mes)}</b> no mês pede <b>${brl0(c.metaDia)} por dia</b> de loja aberta (${c.abMes} dias). Quem puxa esse número: mais vendas por dia, mais peças por cliente e ticket maior — veja os itens abaixo pra saber qual está travando.` });
  if (c.periodo === 'mes') {
    let ate = 0; for (let i = c.ini; i <= c.hoje; i = addDias(i, 1)) if (lojaAbre(i)) ate++;
    L.push({ g: 'Resultado', id: 'fatmes', nome: 'Faturamento do mês', desc: `Até hoje x meta acumulada (${ate} dias de loja)`, v: a.fat, meta: c.metaDia * ate, fmt: brl0, dir: 'up',
      dica: `Pra fechar o mês na meta faltam <b>${brl0(Math.max(0, M.meta_mes - a.fat))}</b> em <b>${Math.max(0, c.abMes - c.diasCompletos)} dias</b> de loja: <b>${brl0(Math.max(0, M.meta_mes - a.fat) / Math.max(1, c.abMes - c.diasCompletos))} por dia</b>.` });
  }
  L.push({ g: 'Movimento', id: 'vendasdia', nome: c.periodo === 'hoje' ? 'Vendas de hoje' : 'Vendas por dia', desc: 'Quantidade de atendimentos que viraram venda', v: p.vendas, meta: vendasMeta, fmt: v => v == null ? '—' : dec1(v).replace(',0', ''), dir: 'up',
    dica: `Com ticket de ${brl0(ticketMeta)}, a meta pede <b>${dec1(vendasMeta)} vendas por dia</b>. Venda vem de gente entrando ou chamando no WhatsApp: anúncio forte do <b>dia 1 ao 13</b> (salário), oferta no grupo VIP no fim do mês e chamar de volta quem já comprou.` });
  L.push({ g: 'Ticket', id: 'ticket', nome: 'Ticket médio', desc: 'Valor médio de cada venda', v: a.ticket, meta: ticketMeta, fmt: brl0, dir: 'up',
    dica: `Ticket = <b>peças por cliente × preço por peça</b>. O caminho mais rápido é a 2ª peça: "leva a bermuda que combina?" em todo atendimento e kits (leve 3).` });
  L.push({ g: 'Ticket', id: 'pa', nome: 'Peças por atendimento (PA)', desc: 'Quantas peças cada cliente leva' + baseP, v: a.pa, meta: M.pa, fmt: dec2, dir: 'up', semDados: !a.temPecas,
    dica: `Regra no caixa: toda venda oferece <b>1 complemento</b> (cueca, meia, cinto, boné) e kits "leve 3". ${a.pa && a.pa < M.pa ? `Subir de ${dec1(a.pa)} pra ${dec1(M.pa)} peças é <b>+${pct(M.pa / a.pa - 1)} de faturamento</b> sem 1 cliente a mais.` : 'Cada peça a mais por cliente é faturamento sem precisar de cliente novo.'}${fato('pa')}` });
  L.push({ g: 'Ticket', id: 'precopeca', nome: 'Preço médio por peça', desc: 'Faturamento ÷ peças' + baseP, v: a.precoPeca, meta: ticketMeta / M.pa, fmt: brl0, dir: 'up', semDados: !a.temPecas,
    dica: `Mostre primeiro as peças de maior valor e deixe as básicas como complemento.${fato('precopeca')}` });
  L.push({ g: 'Cliente', id: 'cadastro', nome: 'Vendas com cadastro', desc: 'Cliente com nome e WhatsApp na Phibo' + base, v: a.cadastro, meta: M.cadastro, fmt: v => pct(v), dir: 'up', semDados: !a.temDet,
    dica: `Cliente sem cadastro <b>não dá pra chamar de volta</b>. Pegue nome + WhatsApp em toda venda (vale um brinde ou cashback).${fato('cadastro')}` });
  L.push({ g: 'Margem', id: 'desconto', nome: 'Desconto dado', desc: '% sobre o valor cheio das peças' + base, v: a.descPct, meta: M.desconto_max, fmt: v => pct(v, 1), dir: 'down', semDados: !a.temDet,
    dica: `Desconto só em promoção combinada (leve 3, kit), nunca pra arredondar o valor.${fato('desconto')}` });
  const vTot = Object.values(a.vend).reduce((s, v) => s + v, 0);
  if (a.temDet && vTot > 0) {
    L.push({ g: 'Equipe', id: 'equipe', nome: 'Divisão das vendas', desc: 'Quanto cada um vendeu no período', info: true, v: null,
      txt: Object.entries(a.vend).filter(e => e[1] > 0).sort((x, y) => y[1] - x[1]).map(([n, v]) => `${esc(n)} <b>${brl0(v)}</b> (${pct(v / vTot)})`).join(' · '),
      dica: `Meta de PA e de cadastro <b>por vendedor</b> ajuda a equipe a puxar junto.${fato('equipe')}` });
  }
  if (a.temDet && (a.pix + a.dinheiro + a.credito + a.debito) > 0) {
    const tot = a.pix + a.dinheiro + a.credito + a.debito + a.outras;
    L.push({ g: 'Pagamento', id: 'pix', nome: 'Pago no Pix', desc: 'Pix e dinheiro não pagam taxa de maquininha', info: true, v: null,
      txt: `Pix <b>${pct(a.pix / tot)}</b> · Dinheiro ${pct(a.dinheiro / tot)} · Crédito ${pct(a.credito / tot)} · Débito ${pct(a.debito / tot)}`,
      dica: `Cartão de crédito em 5x custa ~7% de taxa. Parcelar ajuda a vender peça cara — use a favor do ticket, não como desconto escondido.` });
  }
  const A = c.ads;
  L.push({ g: 'Anúncios', id: 'cpf', nome: 'Custo por seguidor (BH)', desc: 'Gasto ÷ seguidores trazidos pelo anúncio', v: A.cpf, meta: M.cpf_max, fmt: brl, dir: 'down', semDados: !A.n, semTxt: 'Chega com o boletim da manhã.',
    dica: `Quando o custo sobe, o vídeo cansou: refaça só os primeiros segundos do criativo campeão e volte com ele.${fato('cpf')}` });
  L.push({ g: 'Anúncios', id: 'vpr', nome: 'Venda por R$ 1 de anúncio', desc: 'Faturamento da loja ÷ gasto do anúncio BH', v: A.vendaPorReal, meta: M.venda_por_real, fmt: brl0, dir: 'up', semDados: !A.n, semTxt: 'Chega com o boletim da manhã.',
    dica: `Concentre a verba nos dias de salário (1 ao 13) e segure do 14 em diante: o mesmo real vende muito mais no começo do mês.${fato('vpr')}` });
  L.push({ g: 'Anúncios', id: 'gasto', nome: 'Gasto por dia (BH)', desc: c.d <= 13 ? 'Janela do salário: hora de acelerar' : 'Fim do mês: hora de segurar', info: true, v: null,
    txt: A.n ? `<b>${brl(A.porDia)}</b> por dia · ${qtd(A.seguidores)} seguidores · ${qtd(A.conversas)} conversas` : 'Aguardando os dados dos anúncios',
    dica: `Mais verba do dia 1 ao 13, menos do 14 ao fim. O total do mês fica parecido, mas o dinheiro vai pra quando o cliente tem salário.${fato('gasto')}` });
  L.push({ g: 'Instagram', id: 'segig', nome: 'Seguidores novos por dia', desc: 'Saldo do Instagram (ganhos − perdidos)', v: c.ig.porDia, meta: M.seg_ig_dia, fmt: v => v == null ? '—' : qtd(Math.round(v)), dir: 'up', semDados: !c.ig.n, semTxt: 'Chega com o boletim da manhã.',
    dica: `Vídeo com cliente real ("trajado da Belor") e mais de 10s de tempo assistido rende mais que repetir a mesma legenda.${fato('segig')}` });
  L.forEach(x => { x.st = x.info ? 'info' : x.semDados || x.v == null ? 'na' : status(x.v, x.meta, x.dir); x.per = per; });
  return L;
}

/* ---------------- gráficos (SVG à mão, sem bibliotecas) ---------------- */
let chartSeq = 0;
function escala(v) { if (!(v > 0)) v = 1; const alvo = v / 5, p = Math.pow(10, Math.floor(Math.log10(alvo))); const step = [1, 2, 2.5, 5, 10].map(x => x * p).find(x => x >= alvo); const n = Math.max(1, Math.ceil(v / step - 1e-9)); return { max: n * step, step, n }; }
const tkFmt = v => OCULTO() ? '' : v >= 1000 ? nf1.format(v / 1000).replace(',0', '') + 'k' : nf0.format(v);

/* barras por dia: itens {x, v, sub, cls}, opções {meta, zona:[i0,i1,label], h} */
function barras(itens, o = {}) {
  const id = 'c' + (++chartSeq), W = 340, H = o.h || 168, pl = 30, pr = 6, pt = 14, pb = 22;
  const iw = W - pl - pr, ih = H - pt - pb;
  const E = escala(Math.max(o.meta || 0, ...itens.map(i => i.v || 0)) * 1.06), mx = E.max;
  const step = iw / Math.max(1, itens.length), bw = Math.max(2, Math.min(18, step - 2));
  const Y = v => pt + ih - (v / mx) * ih;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || 'gráfico de barras')}">`;
  if (o.zona) { const [a, b, lb] = o.zona; s += `<rect class="zone" x="${pl + a * step}" y="${pt - 2}" width="${(b - a + 1) * step}" height="${ih + 2}" rx="6"/><text class="zlabel" x="${pl + a * step + 6}" y="${pt + 9}">${esc(lb)}</text>`; }
  for (let k = 0; k <= E.n; k++) { const v = E.step * k, y = Y(v); s += `<line class="${k ? 'gl' : 'ax'}" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/><text class="tk" x="${pl - 5}" y="${y + 3}" text-anchor="end">${tkFmt(v)}</text>`; }
  itens.forEach((it, i) => {
    const x = pl + i * step + (step - bw) / 2, v = it.v || 0, y = Y(v), h = pt + ih - y, r = Math.min(4, bw / 2, h);
    if (v > 0) s += `<path class="bar ${it.cls || ''}" d="M${x},${pt + ih} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${pt + ih} Z"/>`;
    if (it.tick) s += `<text class="tk" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(it.tick)}</text>`;
  });
  if (o.meta) s += `<line class="tgt" x1="${pl}" x2="${W - pr}" y1="${Y(o.meta)}" y2="${Y(o.meta)}"/>`;
  itens.forEach((it, i) => { s += `<rect class="hit" data-i="${i}" x="${pl + i * step}" y="${pt}" width="${step}" height="${ih}"/>`; });
  s += `</svg>`;
  registrarTip(id, itens.map((it, i) => ({ x: (pl + i * step + step / 2) / W, y: Y(it.v || 0) / H, t1: it.t1, t2: it.t2, t3: it.t3 })));
  return `<div class="chart" id="${id}">${s}<div class="tip"></div></div>`;
}

/* linhas acumuladas: series [{nome, cls, pts:[valor por dia ou null]}], n = dias no mês */
function linhas(series, n, o = {}) {
  const id = 'c' + (++chartSeq), W = 340, H = o.h || 176, pl = 34, pr = 10, pt = 12, pb = 22;
  const iw = W - pl - pr, ih = H - pt - pb;
  const all = series.flatMap(s => s.pts.filter(v => v != null));
  const E = escala(Math.max(1, ...all) * 1.04), mx = E.max;
  const X = i => pl + (i / Math.max(1, n - 1)) * iw, Y = v => pt + ih - (v / mx) * ih;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || 'gráfico de linhas')}">`;
  for (let k = 0; k <= E.n; k++) { const v = E.step * k, y = Y(v); s += `<line class="${k ? 'gl' : 'ax'}" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/><text class="tk" x="${pl - 5}" y="${y + 3}" text-anchor="end">${tkFmt(v)}</text>`; }
  [1, 5, 10, 15, 20, 25, n].forEach(dd => { if (dd <= n) s += `<text class="tk" x="${X(dd - 1)}" y="${H - 6}" text-anchor="middle">${dd}</text>`; });
  series.forEach(se => {
    let d = '', pen = false;
    se.pts.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(v).toFixed(1); pen = true; });
    if (se.area && d) { const pts = se.pts.map((v, i) => v == null ? null : [X(i), Y(v)]).filter(Boolean); s += `<path class="area" d="M${pts[0][0]},${Y(0)} ${pts.map(p => 'L' + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')} L${pts[pts.length - 1][0]},${Y(0)} Z"/>`; }
    s += `<path class="ln ${se.cls}" d="${d}"/>`;
    const li = se.pts.map((v, i) => v == null ? -1 : i).filter(i => i >= 0).pop();
    if (se.cls === 'cur' && li != null && li >= 0) s += `<circle cx="${X(li)}" cy="${Y(se.pts[li])}" r="4.5" fill="var(--gold)" stroke="var(--surface)" stroke-width="2"/>`;
  });
  s += `<line class="cross" x1="0" x2="0" y1="${pt}" y2="${pt + ih}" style="display:none"/>`;
  for (let i = 0; i < n; i++) s += `<rect class="hit" data-i="${i}" x="${X(i) - iw / n / 2}" y="${pt}" width="${iw / n}" height="${ih}"/>`;
  s += `</svg>`;
  registrarTip(id, Array.from({ length: n }, (_, i) => {
    const vals = series.map(se => se.pts[i]).filter(v => v != null);
    return { x: X(i) / W, y: (vals.length ? Y(Math.max(...vals)) : pt + ih) / H, cx: X(i), t1: `Dia ${i + 1}`, t2: series.map(se => se.pts[i] == null ? '' : `<div>${esc(se.nome)}: <b>${brl0(se.pts[i])}</b></div>`).join('') };
  }), true);
  return `<div class="chart" id="${id}">${s}<div class="tip"></div></div>`;
}

function spark(vals) {
  const v = vals.map(x => x || 0); if (v.length < 2) return '';
  const W = 120, H = 28, mx = Math.max(1, ...v), X = i => (i / (v.length - 1)) * (W - 4) + 2, Y = x => H - 3 - (x / mx) * (H - 7);
  const d = v.map((x, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(x).toFixed(1)).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><circle cx="${X(v.length - 1)}" cy="${Y(v[v.length - 1])}" r="2.6" fill="var(--gold)"/></svg>`;
}

const TIPS = {};
function registrarTip(id, pts, cross) { TIPS[id] = { pts, cross }; }
function ligarTips() {
  document.querySelectorAll('.chart').forEach(ch => {
    const reg = TIPS[ch.id]; if (!reg) return;
    const tip = $('.tip', ch), svg = $('svg', ch), cr = $('.cross', ch);
    const show = i => {
      const p = reg.pts[i]; if (!p) return;
      tip.innerHTML = `<div class="t1">${esc(p.t1 || '')}</div><div class="t2">${p.t2 || ''}</div>${p.t3 ? `<div class="t1" style="margin:3px 0 0">${esc(p.t3)}</div>` : ''}`;
      const w = ch.clientWidth, x = Math.min(Math.max(p.x * w, 70), w - 70);
      tip.style.left = x + 'px'; tip.style.top = (p.y * svg.clientHeight - 8) + 'px'; tip.classList.add('on');
      if (cr && reg.cross) { cr.setAttribute('x1', p.cx); cr.setAttribute('x2', p.cx); cr.style.display = ''; }
      ch.querySelectorAll('.bar.hl').forEach(b => b.classList.remove('hl'));
    };
    const hide = () => { tip.classList.remove('on'); if (cr) cr.style.display = 'none'; };
    ch.addEventListener('pointermove', e => { const t = e.target.closest('.hit'); if (t) show(+t.dataset.i); });
    ch.addEventListener('pointerdown', e => { const t = e.target.closest('.hit'); if (t) show(+t.dataset.i); });
    ch.addEventListener('pointerleave', hide);
  });
}

/* ---------------- ícones ---------------- */
const IC = {
  hoje: '<svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
  mes: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>',
  clientes: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c1.9.7 3.2 2.4 3.5 5.2"/></svg>',
  micro: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20.5 20.5-4.8-4.8M8.5 11h5M11 8.5v5"/></svg>',
  boletim: '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/></svg>',
  ajustes: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  olho: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  olhoX: '<svg viewBox="0 0 24 24"><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.9 3.9M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/></svg>',
  sync: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16m0 4v-4h-4"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  bulb: '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  crown: '<svg viewBox="0 0 640 420" aria-hidden="true"><path d="M70 330 L40 110 L190 220 L320 40 L450 220 L600 110 L570 330 Z"/><rect x="70" y="350" width="500" height="44" rx="10"/><circle cx="40" cy="98" r="30"/><circle cx="320" cy="34" r="32"/><circle cx="600" cy="98" r="30"/></svg>'
};
const ST_ICON = {
  good: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>',
  warn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 3.5v5.5M8 12.2v.1"/></svg>',
  bad: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>',
  info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 7.3v3.2M8 5.2v.1"/></svg>',
  na: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M5.5 8h5"/></svg>'
};
const ST_TXT = { good: 'Bom', warn: 'Atenção', bad: 'Ruim', info: 'Info', na: 'Sem dado' };
const chip = st => `<span class="chip ${st}">${ST_ICON[st]}${ST_TXT[st]}</span>`;

/* ---------------- telas ---------------- */
function topo() {
  const d = S.data, m = d ? minutosDesde(d.ultimo_envio) : null;
  const vivo = m != null && m < 30, h = d && horaDe(d.ultimo_envio);
  const quando = m != null && m >= 20 * 60 ? new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' }).format(new Date(String(d.ultimo_envio).split(' ')[0])) + ' ' : '';
  return `<header class="top"><div class="brand">${IC.crown}BELOR</div>
    <div class="sync"><span class="dot ${vivo ? 'live' : m != null && m > 150 ? 'stale' : ''}"></span>${h ? 'Loja ' + quando + 'às ' + h : 'Sem dados'}
    <button class="iconbtn" id="btnOlho" aria-pressed="${OCULTO()}" aria-label="${OCULTO() ? 'Mostrar valores' : 'Esconder valores'}">${OCULTO() ? IC.olhoX : IC.olho}</button>
    <button class="iconbtn ${S.loading ? 'spin' : ''}" id="btnSync" aria-label="Atualizar">${IC.sync}</button></div></header>`;
}
function atualizarBotaoSync() { const b = $('#btnSync'); if (b) b.classList.toggle('spin', !!S.loading); }

function alertaLeitor() {
  const d = S.data; if (!d || !d.ultimo_envio) return '';
  const m = minutosDesde(d.ultimo_envio), t = agoraSP();
  const lojaAberta = (t.dow >= 1 && t.dow <= 5 && t.min >= 9 * 60 && t.min <= 19 * 60 + 30) || (t.dow === 6 && t.min >= 8 * 60 + 30 && t.min <= 17 * 60);
  if (!lojaAberta || m == null || m < 150) return '';
  return `<div class="alert warn">${IC.warn}<div>A loja mandou o último número às <b>${horaDe(d.ultimo_envio)}</b> (há ${durTxt(m)}). Se teve venda depois disso, confira se a <b>Phibo está aberta e logada no Chrome do PC da loja</b>.</div></div>`;
}

function telaHoje() {
  const hoje = hojeISO(), M = metas(), { y, m } = ymd(hoje);
  const r = linhaDe(hoje) || { faturamento: 0, vendas: 0 }, ontemISO = (() => { let i = addDias(hoje, -1); while (!lojaAbre(i) && i > addDias(hoje, -8)) i = addDias(i, -1); return i; })();
  const o = linhaDe(ontemISO), metaDia = M.meta_mes / diasAbertosMes(y, m);
  const fat = r.faturamento || 0, v = r.vendas || 0, ticket = v ? fat / v : null, pa = r.pecas && v ? r.pecas / v : r.pa;
  const prog = metaDia ? fat / metaDia : 0, falta = Math.max(0, metaDia - fat);
  const aberta = lojaAbre(hoje);
  const ult7v = []; for (let i = 6; i >= 0; i--) { const ri = linhaDe(addDias(hoje, -i)); ult7v.push(ri ? ri.vendas : 0); }
  const ult7t = []; for (let i = 13; i >= 0; i--) { const ri = linhaDe(addDias(hoje, -i)); if (ri && ri.vendas > 0) ult7t.push(ri.faturamento / ri.vendas); }
  const semcad = r.sem_cad_vendas, semcadPct = v && semcad != null ? semcad / v : null;
  const tot = (r.pix || 0) + (r.dinheiro || 0) + (r.credito || 0) + (r.debito || 0) + (r.outras_formas || 0);
  const vendE = Object.entries(r.vend || {}), totV = vendE.reduce((s, e) => s + (e[1] || 0), 0);
  let corI = 0; const corVend = vendE.map(([n]) => /^outros$/i.test(n) ? 'var(--ghost)' : ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'][Math.min(3, corI++)]);
  const comp = (a, b) => { if (a == null || b == null || !b) return ''; const dlt = (a - b) / b; return `<span class="${dlt >= 0 ? 'up' : 'down'}">${dlt >= 0 ? '▲' : '▼'} ${pct(Math.abs(dlt))}</span> vs ${ddmm(ontemISO)}`; };
  let h = alertaLeitor();
  h += `<div class="card hero fade-in"><div class="hero-l">${aberta ? 'Vendido hoje · ' + DSEML[dowOf(hoje)] + ', ' + ddmm(hoje) : 'Loja fechada hoje (' + DSEML[dowOf(hoje)] + ')'}</div>
    <div class="hero-v num"><small>R$</small>${OCULTO() ? MASK : nf2.format(fat)}</div>
    <div class="hero-s"><b>${qtd(v)}</b> ${v === 1 ? 'venda' : 'vendas'}${ticket ? ` · ticket <b>${brl0(ticket)}</b>` : ''}${pa ? ` · PA <b>${dec1(pa)}</b>` : ''}</div>
    ${aberta ? `<div class="meter"><div class="meter-row"><span>Meta do dia <b>${brl0(metaDia)}</b></span><span><b>${pct(prog)}</b></span></div>
      <div class="track"><div class="fill ${prog >= 1 ? 'over' : ''}" style="width:${Math.min(100, prog * 100)}%"></div></div>
      <div class="meter-foot">${prog >= 1 ? `${chip('good')} Meta do dia batida! <b>+${brl0(fat - metaDia)}</b>` : `Faltam <b>${brl0(falta)}</b> pra meta do dia${M.ticket ? ` — umas <b>${qtd(Math.ceil(falta / (ticket || M.ticket)))}</b> vendas` : ''}`}</div></div>` : ''}
  </div>`;
  h += `<div class="tiles">
    <div class="tile"><div class="tile-l">Vendas</div><div class="tile-v num">${qtd(v)}</div><div class="tile-d">${o ? comp(v, o.vendas) : 'últimos 7 dias'}</div>${spark(ult7v)}</div>
    <div class="tile"><div class="tile-l">Ticket médio</div><div class="tile-v num">${ticket ? brl0(ticket) : '—'}</div><div class="tile-d">meta ${brl0(M.ticket)}</div>${spark(ult7t.slice(-7))}</div>
    <div class="tile"><div class="tile-l">Peças por cliente</div><div class="tile-v num">${pa ? dec1(pa) : '—'}</div><div class="tile-d">meta ${dec1(M.pa)}${r.pecas != null ? ` · ${qtd(r.pecas)} peças` : ''}</div></div>
    <div class="tile"><div class="tile-l">Cadastros</div><div class="tile-v num">${semcad != null && v ? qtd(v - semcad) + '<small> de ' + qtd(v) + '</small>' : '—'}</div><div class="tile-d">${semcadPct != null ? `<span class="${(1 - semcadPct) >= M.cadastro ? 'up' : 'down'}">${pct(1 - semcadPct)}</span> das vendas com cadastro` : 'sem vendas ainda'}</div></div>
  </div>`;
  const cliHoje = (S.data.clientes || []).find(c => c.data === hoje);
  if (cliHoje && cliHoje.novos > 0) h += `<div class="card"><div class="card-h"><div class="card-t">Clientes novos hoje</div><div class="card-a">${qtd(cliHoje.novos)} ${cliHoje.novos === 1 ? 'cadastrado' : 'cadastrados'}</div></div>${origemBars(cliHoje.origens) || '<div class="hint">De onde vieram: ainda lendo na Phibo.</div>'}</div>`;
  if (totV > 0) h += `<div class="card"><div class="card-h"><div class="card-t">Por vendedor</div><div class="card-a">hoje</div></div><div class="hbars">
    ${vendE.map((e, i) => [esc(e[0]), e[1], corVend[i]]).filter(x => x[1]).map(x => `<div><div class="hb-top"><span><i class="sw" style="background:${x[2]}"></i>${x[0]}</span><span>${brl0(x[1])} <i>· ${pct(x[1] / totV)}</i></span></div><div class="hb-track"><div class="hb-fill" style="width:${x[1] / totV * 100}%;background:${x[2]}"></div></div></div>`).join('')}</div></div>`;
  if (tot > 0) h += `<div class="card"><div class="card-h"><div class="card-t">Formas de pagamento</div><div class="card-a">hoje</div></div><div class="hbars">
    ${[['Pix', r.pix, 'var(--s1)'], ['Dinheiro', r.dinheiro, 'var(--s2)'], ['Crédito', r.credito, 'var(--s3)'], ['Débito', r.debito, 'var(--s4)'], ['Outras', r.outras_formas, 'var(--ghost)']].filter(x => x[1]).map(x => `<div><div class="hb-top"><span><i class="sw" style="background:${x[2]}"></i>${x[0]}</span><span>${brl0(x[1])} <i>· ${pct(x[1] / tot)}</i></span></div><div class="hb-track"><div class="hb-fill" style="width:${x[1] / tot * 100}%;background:${x[2]}"></div></div></div>`).join('')}</div></div>`;
  // últimos 7 dias
  const it7 = []; for (let i = 6; i >= 0; i--) { const di = addDias(hoje, -i), ri = linhaDe(di); it7.push({ v: ri ? ri.faturamento : 0, tick: DSEM[dowOf(di)], cls: di === hoje ? 'today' : '', t1: `${cap(DSEML[dowOf(di)])}, ${ddmm(di)}`, t2: brl0(ri ? ri.faturamento : 0), t3: ri && ri.vendas ? `${qtd(ri.vendas)} vendas` : ri && ri.faturamento ? '' : (lojaAbre(di) ? 'sem venda' : 'loja fechada') }); }
  h += `<div class="card"><div class="card-h"><div class="card-t">Últimos 7 dias</div><div class="card-a">meta/dia ${brlK(metaDia)}</div></div>${barras(it7, { meta: metaDia, h: 150, aria: 'Faturamento dos últimos 7 dias' })}
    <div class="legend"><span class="k"><i style="background:var(--gold)"></i>Faturamento</span><span class="k"><i class="dash"></i>Meta do dia</span></div></div>`;
  if (o) h += `<div class="card"><div class="card-h"><div class="card-t">Último dia de loja</div><div class="card-a">${cap(DSEML[dowOf(ontemISO)])}, ${ddmm(ontemISO)}</div></div>
    <div class="row"><span>Faturamento</span><span class="num">${brl(o.faturamento)}</span></div>
    <div class="row"><span>Vendas</span><span class="num">${o.vendas != null ? qtd(o.vendas) : '—'}</span></div>
    <div class="row"><span>Ticket médio</span><span class="num">${o.vendas ? brl0(o.faturamento / o.vendas) : '—'}</span></div>
    ${o.pecas != null && o.detalhe ? `<div class="row"><span>Peças por cliente</span><span class="num">${o.vendas ? dec1(o.pecas / o.vendas) : '—'}</span></div>` : ''}
    <div class="row"><span>x meta do dia</span><span>${chip(status(o.faturamento, metaDia, 'up'))}</span></div></div>`;
  return h;
}

/* ---------------- clientes ---------------- */
function origemBars(o, dica) {
  const itens = Object.entries(o || {}).filter(e => e[1] > 0).sort((a, b) => b[1] - a[1]), tot = itens.reduce((t, e) => t + e[1], 0);
  if (!tot) return '';
  let i = 0; const cor = n => /não informado|já cadastrado|outros/i.test(n) ? 'var(--ghost)' : ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5, var(--gold))'][Math.min(4, i++)];
  return `<div class="hbars">${itens.map(([n, q]) => { const c = cor(n); return `<div><div class="hb-top"><span><i class="sw" style="background:${c}"></i>${esc(n)}</span><span>${qtd(q)} <i>· ${pct(q / tot)}</i></span></div><div class="hb-track"><div class="hb-fill" style="width:${q / tot * 100}%;background:${c}"></div></div></div>`; }).join('')}</div>`;
}
const somaOrigens = rows => { const o = {}; rows.forEach(r => { for (const k in (r.origens || {})) o[k] = (o[k] || 0) + (r.origens[k] || 0); }); return o; };

function telaClientes() {
  const hoje = hojeISO(), M = metas(), { y, m } = ymd(hoje), ini = isoDe(y, m, 1);
  const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y, iniAnt = isoDe(py, pm, 1), fimAnt = isoDe(py, pm, diasNoMes(py, pm));
  const cli = S.data.clientes || [], doMes = cli.filter(r => r.data >= ini && r.data <= hoje), doAnt = cli.filter(r => r.data >= iniAnt && r.data <= fimAnt);
  const novosMes = sum(doMes, r => r.novos), novosAnt = sum(doAnt, r => r.novos);
  const snaps = doMes.filter(r => r.voltaram != null), snap = snaps[snaps.length - 1] || null;
  // vendas com / sem cadastro no mês: o painel do mês da Phibo (exato); se faltar, soma dos dias com detalhe
  let vM = snap && snap.vendasMes != null ? snap.vendasMes : null, sM = snap && snap.semCadMes != null ? snap.semCadMes : null, base = '';
  if (vM == null || sM == null) {
    const det = S.data.vendas.filter(r => r.data >= ini && r.data <= hoje && r.detalhe && r.vendas != null && r.sem_cad_vendas != null);
    vM = sum(det, r => r.vendas); sM = sum(det, r => r.sem_cad_vendas); base = det.length ? `<div class="hint">Só dos ${det.length} dias com detalhe.</div>` : '';
  }
  const com = vM != null && sM != null ? vM - sM : null, pc = vM ? com / vM : null, st = status(pc, M.cadastro, 'up');
  const falta = vM && pc != null && pc < M.cadastro ? Math.max(0, Math.ceil(M.cadastro * vM - com)) : 0;
  let h = '';
  // 1) cadastros no mês
  h += `<div class="card hero fade-in"><div class="hero-l">Vendas com cadastro · ${MES[m - 1]}</div>
    <div class="hero-v num">${com != null && vM ? qtd(com) : '—'}<small> de ${vM ? qtd(vM) : '—'} vendas</small></div>
    <div class="hero-s">${pc != null ? `<b>${pct(pc)}</b> com cadastro ${chip(st)} · meta <b>${pct(M.cadastro)}</b>` : 'Sem dados do mês ainda'}</div>
    ${pc != null ? `<div class="meter"><div class="track"><div class="fill ${pc >= M.cadastro ? 'over' : ''}" style="width:${Math.min(100, pc / M.cadastro * 100)}%"></div></div>
      <div class="meter-foot">${falta ? `Faltam <b>${qtd(falta)}</b> ${falta === 1 ? 'cadastro' : 'cadastros'} nas vendas do mês pra chegar na meta` : 'Meta de cadastro batida!'}</div></div>` : ''}${base}
    <div class="row"><span>Vendas sem cadastro</span><span class="num">${sM != null ? qtd(sM) : '—'}${vM && sM != null ? ' <i style="font-style:normal;color:var(--muted)">(' + pct(sM / vM) + ')</i>' : ''}</span></div>
    <div class="row"><span>Clientes novos cadastrados</span><span class="num">${doMes.length ? qtd(novosMes) : '—'}${novosAnt ? ' <i style="font-style:normal;color:var(--muted)">(' + MES[pm - 1].slice(0, 3).toLowerCase() + ': ' + qtd(novosAnt) + ')</i>' : ''}</span></div>
  </div>`;
  // 2) quem voltou
  if (snap) {
    const serie = snaps.map(r => r.voltaram), ant = snaps.length > 1 ? snaps[snaps.length - 2] : null, dif = ant ? snap.voltaram - ant.voltaram : null;
    const pv = snap.compraram ? snap.voltaram / snap.compraram : null;
    h += `<div class="card"><div class="card-h"><div class="card-t">Clientes que voltaram a comprar</div><div class="card-a">${MES[m - 1].toLowerCase()}</div></div>
      <div class="hero-v num" style="font-size:44px">${qtd(snap.voltaram)}<small> ${snap.voltaram === 1 ? 'cliente' : 'clientes'}</small></div>
      <div class="hero-s">de <b>${qtd(snap.compraram)}</b> que compraram no mês${pv != null ? ` · <b>${pct(pv)}</b>` : ''}${dif ? ` · <span class="${dif > 0 ? 'up' : 'down'}">${dif > 0 ? '▲ +' : '▼ '}${qtd(dif)}</span> desde ${ddmm(ant.data)}` : ''}</div>
      ${serie.length > 1 ? `<div class="sparkbox">${spark(serie)}</div>` : ''}
      <div class="hint">Voltou = cliente cadastrado que comprou de novo em outro dia. Base total: ${snap.base != null ? qtd(snap.base) : '—'} clientes cadastrados.</div></div>`;
  }
  // 3) de onde vêm
  const oMes = somaOrigens(doMes), tot = Object.values(oMes).reduce((t, v) => t + v, 0);
  if (tot) {
    const top = Object.entries(oMes).sort((a, b) => b[1] - a[1])[0];
    h += `<div class="card"><div class="card-h"><div class="card-t">De onde vêm os clientes novos</div><div class="card-a">${qtd(tot)} no mês</div></div>${origemBars(oMes)}
      <div class="hint">É o que o cliente responde em "Como nos conheceu" no cadastro. ${top ? `Mais forte: <b>${esc(top[0])}</b>.` : ''}</div></div>`;
  }
  // 4) cadastros por dia
  const dias = []; for (let i = 13; i >= 0; i--) dias.push(addDias(hoje, -i));
  if (cli.some(r => dias.includes(r.data) && r.novos)) {
    const it = dias.map(d => { const r = cli.find(x => x.data === d), q = r ? (r.novos || 0) : 0; return { v: q, tick: String(+d.slice(8)), cls: d === hoje ? 'today' : '', t1: `${cap(DSEML[dowOf(d)])}, ${ddmm(d)}`, t2: `${qtd(q)} ${q === 1 ? 'cadastro novo' : 'cadastros novos'}`, t3: r && r.origens && Object.keys(r.origens).length ? Object.entries(r.origens).map(e => e[0] + ' ' + e[1]).join(' · ') : '' }; });
    h += `<div class="card"><div class="card-h"><div class="card-t">Cadastros novos por dia</div><div class="card-a">últimos 14 dias</div></div>${barras(it, { h: 140, aria: 'Cadastros novos por dia' })}</div>`;
  }
  if (!cli.length) h += `<div class="card"><div class="hint">Os números de clientes aparecem aqui assim que o leitor da loja for atualizado (versão 2.1). Os de cadastro das vendas já vêm da Phibo.</div></div>`;
  return h;
}

function telaMes() {
  const hoje = hojeISO(), { y, m, d } = ymd(hoje), M = metas(), c = contexto('mes'), a = c.ag;
  const n = diasNoMes(y, m), abMes = c.abMes, metaDia = c.metaDia;
  let ate = 0; for (let i = 1; i <= d; i++) if (lojaAbre(isoDe(y, m, i))) ate++;
  const restantes = abMes - c.diasCompletos;
  const precisa = Math.max(0, M.meta_mes - a.fat) / Math.max(1, restantes);
  const ritmo = c.diasCompletos ? c.agC.fat / c.diasCompletos : null;
  const proj = ritmo != null ? c.agC.fat + ritmo * restantes : null;
  const prog = a.fat / M.meta_mes, paceFrac = (ate - (lojaAbre(hoje) ? 0.5 : 0)) / abMes;
  // séries acumuladas
  const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y, nPrev = diasNoMes(py, pm);
  const cur = [], prev = [], meta = []; let ac = 0, ap = 0, am = 0;
  for (let i = 1; i <= n; i++) {
    const iso = isoDe(y, m, i);
    if (iso <= hoje) { const r = linhaDe(iso); ac += r ? (r.faturamento || 0) : 0; cur.push(ac); } else cur.push(null);
    if (i <= nPrev) { const r = linhaDe(isoDe(py, pm, i)); ap += r ? (r.faturamento || 0) : 0; prev.push(ap); } else prev.push(null);
    if (lojaAbre(iso)) am += metaDia; meta.push(am);
  }
  const temPrev = (S.data.vendas || []).some(r => r.data.startsWith(`${py}-${String(pm).padStart(2, '0')}`));
  const prevAte = temPrev ? prev[Math.min(d, nPrev) - 1] : null;
  // por dia
  const itens = []; let melhor = null;
  for (let i = 1; i <= n; i++) {
    const iso = isoDe(y, m, i), r = linhaDe(iso), v = r ? r.faturamento : 0;
    if (r && (!melhor || v > melhor.v)) melhor = { v, iso, vendas: r.vendas };
    itens.push({ v, tick: [1, 5, 10, 15, 20, 25, n].includes(i) ? String(i) : '', cls: iso === hoje ? 'today' : iso > hoje ? 'dim' : '', t1: `${cap(DSEML[dowOf(iso)])}, ${ddmm(iso)}`, t2: brl0(v), t3: r && r.vendas ? `${qtd(r.vendas)} vendas · ticket ${brl0(v / r.vendas)}` : r && r.faturamento ? '' : lojaAbre(iso) ? (iso > hoje ? 'ainda vai chegar' : 'sem venda') : 'loja fechada' });
  }
  // dia da semana
  const dsS = [0, 0, 0, 0, 0, 0, 0], dsN = [0, 0, 0, 0, 0, 0, 0];
  (S.data.vendas || []).filter(r => r.data >= addDias(hoje, -55) && r.data < hoje && lojaAbre(r.data)).forEach(r => { const w = dowOf(r.data); dsS[w] += r.faturamento || 0; dsN[w]++; });
  const dsIt = [1, 2, 3, 4, 5, 6].map(w => ({ v: dsN[w] ? dsS[w] / dsN[w] : 0, tick: DSEM[w], t1: cap(DSEML[w]), t2: brl0(dsN[w] ? dsS[w] / dsN[w] : 0), t3: `média de ${dsN[w]} ${dsN[w] === 1 ? 'dia' : 'dias'}` }));
  const piorDs = dsIt.reduce((p, x) => x.v && (!p || x.v < p.v) ? x : p, null);
  let h = `<div class="card hero fade-in"><div class="hero-l">${cap(MES[m - 1])} até agora</div>
    <div class="hero-v num"><small>R$</small>${OCULTO() ? MASK : nf0.format(Math.round(a.fat))}</div>
    <div class="hero-s">de <b>${brl0(M.meta_mes)}</b> · ${qtd(a.vendas)} vendas · ticket <b>${brl0(a.ticket)}</b></div>
    <div class="meter"><div class="meter-row"><span>Meta do mês</span><span><b>${pct(prog)}</b></span></div>
      <div class="track"><div class="fill ${prog >= 1 ? 'over' : ''}" style="width:${Math.min(100, prog * 100)}%"></div><div class="pace" style="left:${Math.min(100, paceFrac * 100)}%" data-l="hoje devia: ${pct(paceFrac)}"></div></div>
      <div class="meter-foot">${prog >= 1 ? `${chip('good')} Meta do mês batida!` : `Pra bater: <b>${brl0(precisa)}/dia</b> nos ${restantes} dias de loja que faltam${lojaAbre(hoje) ? ' (com hoje)' : ''}`}</div></div></div>`;
  h += `<div class="tiles">
    <div class="tile"><div class="tile-l">Projeção no ritmo</div><div class="tile-v num">${brlK(proj)}</div><div class="tile-d">${ritmo ? brl0(ritmo) + '/dia de média' : '—'}</div></div>
    <div class="tile"><div class="tile-l">Mês passado (até dia ${d})</div><div class="tile-v num">${prevAte != null ? brlK(prevAte) : '—'}</div><div class="tile-d">${prevAte ? `<span class="${a.fat >= prevAte ? 'up' : 'down'}">${a.fat >= prevAte ? '▲' : '▼'} ${pct(Math.abs(a.fat - prevAte) / prevAte)}</span> ${cap(MES[pm - 1]).slice(0, 3)}` : 'sem dado'}</div></div>
    <div class="tile"><div class="tile-l">Melhor dia</div><div class="tile-v num">${melhor ? brlK(melhor.v) : '—'}</div><div class="tile-d">${melhor ? `${ddmm(melhor.iso)} · ${qtd(melhor.vendas)} vendas` : ''}</div></div>
    <div class="tile"><div class="tile-l">Dias de loja</div><div class="tile-v num">${ate}<small>/${abMes}</small></div><div class="tile-d">${abMes - ate ? `faltam ${abMes - ate}${lojaAbre(hoje) ? ' depois de hoje' : ''}` : 'último dia do mês'}</div></div></div>`;
  h += `<div class="card"><div class="card-h"><div class="card-t">Acumulado do mês</div><div class="card-a">x meta e x mês passado</div></div>
    ${linhas([{ nome: cap(MES[m - 1]), cls: 'cur', pts: cur, area: true }, ...(temPrev ? [{ nome: cap(MES[pm - 1]), cls: 'prev', pts: prev.slice(0, n) }] : []), { nome: 'Meta', cls: 'meta', pts: meta }], n, { aria: 'Faturamento acumulado do mês' })}
    <div class="legend"><span class="k"><i style="background:var(--gold)"></i>${cap(MES[m - 1])}</span>${temPrev ? `<span class="k"><i style="background:var(--ghost)"></i>${cap(MES[pm - 1])}</span>` : ''}<span class="k"><i class="dash"></i>Meta ${brlK(M.meta_mes)}</span></div></div>`;
  h += `<div class="card"><div class="card-h"><div class="card-t">Faturamento por dia</div><div class="card-a">meta/dia ${brlK(metaDia)}</div></div>
    ${barras(itens, { meta: metaDia, zona: [0, 12, 'SALÁRIO (1–13)'], aria: 'Faturamento por dia do mês' })}
    <div class="legend"><span class="k"><i style="background:var(--gold)"></i>Faturamento</span><span class="k"><i class="dash"></i>Meta do dia</span><span class="k"><i style="background:var(--gold-soft);height:9px"></i>Janela do salário</span></div>
    <button class="tablelink" data-act="tabela">Ver em tabela</button>
    ${S.abertos.tabela ? `<table class="dt"><thead><tr><th>Dia</th><th>Faturamento</th><th>Vendas</th><th>Ticket</th></tr></thead><tbody>${(S.data.vendas || []).filter(r => r.data.startsWith(hoje.slice(0, 7)) && (r.vendas || 0) > 0).map(r => `<tr><td>${ddmm(r.data)} ${DSEM[dowOf(r.data)]}</td><td>${brl0(r.faturamento)}</td><td>${qtd(r.vendas)}</td><td>${brl0(r.faturamento / r.vendas)}</td></tr>`).join('')}</tbody></table>` : ''}</div>`;
  h += `<div class="card"><div class="card-h"><div class="card-t">Média por dia da semana</div><div class="card-a">últimas 8 semanas</div></div>${barras(dsIt, { h: 140, aria: 'Média de faturamento por dia da semana' })}
    ${piorDs ? `<div class="meter-foot mt8">Dia mais fraco: <b>${piorDs.t1}</b> (${piorDs.t2}). Bom dia pra oferta no grupo VIP ou live.</div>` : ''}</div>`;
  return h;
}

function telaMicro() {
  const c = contexto(S.periodo), L = microdados(c);
  const cnt = { good: 0, warn: 0, bad: 0 }; L.forEach(x => { if (cnt[x.st] != null) cnt[x.st]++; });
  const g = id => L.find(x => x.id === id) || {};
  const node = (x, lbl, sub, cls) => `<div class="node ${x.st || 'na'} ${cls || ''}"><div class="n1">${lbl}</div><div class="n2 num">${x.v == null ? '—' : x.fmt(x.v)}</div><div class="n3">${sub || (x.meta != null ? 'meta ' + x.fmt(x.meta) : '')}</div></div>`;
  let h = `<div class="seg" role="group" aria-label="Período">${[['hoje', 'Hoje'], ['7d', '7 dias'], ['mes', 'Mês']].map(([k, t]) => `<button data-per="${k}" aria-pressed="${S.periodo === k}">${t}</button>`).join('')}</div>`;
  h += `<div class="card fade-in"><div class="card-h"><div class="card-t">Saúde da loja</div><div class="card-a">${c.periodo === 'hoje' ? 'hoje' : c.periodo === '7d' ? 'últimos 7 dias' : cap(MES[c.m - 1])}</div></div>
    <div class="tree">
      ${node(g('fatdia'), c.periodo === 'hoje' ? 'FATURAMENTO DE HOJE' : 'FATURAMENTO POR DIA', '', 'root')}
      <div class="tree-eq">= vendas × ticket</div>
      <div class="tree-row">${node(g('vendasdia'), c.periodo === 'hoje' ? 'VENDAS HOJE' : 'VENDAS POR DIA')}<div class="op">×</div>${node(g('ticket'), 'TICKET MÉDIO')}</div>
      <div class="tree-eq">ticket = peças × preço da peça</div>
      <div class="tree-row">${node(g('pa'), 'PEÇAS POR CLIENTE')}<div class="op">×</div>${node(g('precopeca'), 'PREÇO POR PEÇA')}</div>
    </div>
    <div class="health">${cnt.good ? chip('good').replace('Bom', cnt.good + ' bom' + (cnt.good > 1 ? 's' : '')) : ''}${cnt.warn ? chip('warn').replace('Atenção', cnt.warn + ' atenção') : ''}${cnt.bad ? chip('bad').replace('Ruim', cnt.bad + ' ruim' + (cnt.bad > 1 ? 's' : '')) : ''}</div></div>`;
  // prioridades: piores primeiro
  const gap = x => x.dir === 'down' ? x.v / x.meta - 1 : 1 - x.v / x.meta;
  const pri = L.filter(x => x.g !== 'Resultado' && (x.st === 'bad' || x.st === 'warn')).sort((a, b) => gap(b) - gap(a)).slice(0, 3);
  if (pri.length) h += `<div class="card"><div class="card-h"><div class="card-t">Atacar primeiro</div></div>${pri.map((x, i) => `<div class="diag-i"><div class="diag-n r">${i + 1}</div><div><div class="diag-t">${esc(x.nome)}: ${x.fmt(x.v)} <span class="muted small">(meta ${x.fmt(x.meta)})</span></div><div class="diag-b">${x.dica}</div></div></div>`).join('')}</div>`;
  const grupos = [...new Set(L.map(x => x.g))];
  grupos.forEach(gr => {
    h += `<div class="sec">${gr}</div><div class="card flush">` + L.filter(x => x.g === gr).map(x => {
      let corpo = '';
      if (x.info) corpo = `<div class="m-gap">${x.txt}</div>`;
      else if (x.st === 'na') corpo = `<div class="m-gap">${x.semDados ? (x.semTxt || 'Ainda sem esse dado no período — começa a aparecer conforme o leitor da loja manda os detalhes.') : 'Sem dado no período.'}</div>`;
      else {
        const r = x.dir === 'down' ? x.v / x.meta : x.v / x.meta;
        const fillPct = x.dir === 'down' ? Math.min(100, r * 50) : Math.min(100, r / 1.25 * 100);
        const tgtPct = x.dir === 'down' ? 50 : 80;
        let gap;
        if (x.dir === 'up') gap = x.v >= x.meta ? `<b>${pct(x.v / x.meta - 1)} acima</b> da meta` : `Está <b>${pct(1 - x.v / x.meta)} abaixo</b> — devia estar em <b>${x.fmt(x.meta)}</b>`;
        else gap = x.v <= x.meta ? `Dentro do limite de <b>${x.fmt(x.meta)}</b>` : `Está <b>${x.fmt(x.v - x.meta)}</b> acima do limite de ${x.fmt(x.meta)}`;
        corpo = `<div class="m-vals"><span class="m-v num">${x.fmt(x.v)}</span><span class="m-t">meta ${x.dir === 'down' ? 'até ' : ''}${x.fmt(x.meta)}</span></div>
          <div class="bullet"><div class="bf ${x.st}" style="width:${fillPct}%"></div><div class="bt" style="left:${tgtPct}%"></div></div><div class="m-gap">${gap}</div>`;
      }
      return `<div class="metric"><div class="m-top"><div><div class="m-name">${esc(x.nome)}</div><div class="m-desc">${esc(x.desc)}</div></div>${chip(x.st)}</div>${corpo}
        <details class="tipbox"${S.abertos['d_' + x.id] ? ' open' : ''} data-id="${x.id}"><summary>${IC.bulb}O que fazer${IC.chev}</summary><div class="tb">${x.dica}</div></details></div>`;
    }).join('') + `</div>`;
  });
  // diagnóstico (vem do servidor, com o código de acesso)
  const D = S.data && S.data.diagnostico;
  if (!D || !D.travou) return h;
  h += `<div class="sec">Diagnóstico · por que travou</div><div class="card">${D.travou.map((t, i) => `<div class="diag-i"><div class="diag-n r">${i + 1}</div><div><div class="diag-t">${esc(t[0])}</div><div class="diag-b">${mascara(t[1])}</div></div></div>`).join('')}<div class="small muted mt8">Análise da Phibo e dos anúncios de set/out · ${esc(D.data)}</div></div>`;
  h += `<div class="sec">Plano pra destravar</div><div class="card">${D.plano.map((t, i) => `<div class="diag-i"><div class="diag-n">${i + 1}</div><div><div class="diag-t">${esc(t[0])}</div><div class="diag-b">${mascara(t[1])}</div>${t[2] ? `<span class="impact">${esc(mascara(t[2]))}</span>` : ''}</div></div>`).join('')}
    <div class="alert good mt12">${IC.ok}<div>${mascara(D.fecho)} <span class="muted">(estimativa)</span></div></div></div>`;
  return h;
}

function telaBoletim() {
  const d = S.data, b = d && d.boletim;
  let h = '';
  if (!b) {
    h += `<div class="card"><div class="empty">${IC.boletim.replace('<svg', '<svg style="width:34px;height:34px;stroke:var(--muted);fill:none;stroke-width:1.6"')}<br>O boletim aparece aqui todo dia às 7h47.<br>Enquanto isso, o completo está no link abaixo.</div>
      <a class="btn ghost" href="${BOLETIM_URL}" target="_blank" rel="noopener">${IC.ext}Abrir boletim completo</a></div>`;
    return h;
  }
  const tomTxt = { bom: 'good', normal: 'info', ruim: 'bad', ok: 'good', alerta: 'warn' };
  h += `<div class="card hero fade-in"><div class="hero-l">Boletim de ${b.data ? cap(DSEML[dowOf(b.data)]) + ', ' + ddmm(b.data) : 'ontem'}</div>
    <div class="manchete">${esc(mascara(b.manchete || ''))}</div>
    ${b.destaque_texto ? `<div class="alert ${b.destaque_tipo === 'atencao' ? 'bad' : 'good'}">${b.destaque_tipo === 'atencao' ? IC.warn : IC.ok}<div>${esc(mascara(b.destaque_texto))}</div></div>` : ''}
    <div class="sec" style="margin:14px 0 4px">Fazer hoje</div>
    ${[b.fazer_1, b.fazer_2].filter(Boolean).map((t, i) => `<div class="todo"><div class="tn">${i + 1}</div><div>${esc(mascara(t))}</div></div>`).join('')}</div>`;
  h += `<div class="card"><div class="card-h"><div class="card-t">Leitura do dia</div></div>
    ${[['Loja', b.leitura_loja, b.tom_loja], ['Anúncios', b.leitura_pago, b.tom_pago], ['Redes', b.leitura_organico, b.tom_organico]].filter(x => x[1]).map(x => `<div class="reading">${chip(tomTxt[x[2]] || 'info').replace(/>(Bom|Info|Ruim|Atenção)</, '>' + x[0] + '<')}<div class="rt">${esc(mascara(x[1]))}</div></div>`).join('')}</div>`;
  const rowsBH = (b.pago || []).filter(p => /\bBH\b/i.test(String(p.campanha || '')));
  if (rowsBH.length) {
    const rows = rowsBH;
    h += `<div class="card"><div class="card-h"><div class="card-t">Anúncios de ontem</div><div class="card-a">só loja BH</div></div>
      <table class="dt"><thead><tr><th>Campanha</th><th>Gasto</th><th>Seg.</th><th>R$/seg.</th><th>CTR</th></tr></thead><tbody>
      ${rows.map(p => `<tr><td>${esc(p.campanha)}</td><td>${brl(p.gasto)}</td><td>${p.seguidores != null ? qtd(p.seguidores) : '—'}</td><td>${p.custo_seguidor != null ? dec2(p.custo_seguidor) : '—'}</td><td>${p.ctr != null ? dec1(p.ctr) + '%' : '—'}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  if (b.organico && b.organico.length) {
    h += `<div class="card"><div class="card-h"><div class="card-t">Redes</div><div class="card-a">Metricool</div></div>
      ${b.organico.map(o => `<div class="row"><span>${esc(o.rede)}</span><span><b class="num">${o.seguidores_total != null ? qtd(o.seguidores_total) : '—'}</b> seguidores${o.seguidores_ganhos != null ? ` · <span class="up">+${qtd(o.seguidores_ganhos)}</span> <span class="down">−${qtd(o.seguidores_perdidos || 0)}</span> em ${o.dia_seguidores ? ddmm(o.dia_seguidores) : ''}` : ''}</span></div>`).join('')}</div>`;
  }
  if (b.videos && b.videos.length) {
    h += `<div class="card"><div class="card-h"><div class="card-t">Vídeos de ontem</div></div>
      ${b.videos.map(v => `<div class="row"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(v.legenda || v.rede)}</span><span class="num">${qtd(v.views || 0)} views${v.tempo_medio_s ? ' · ' + dec1(v.tempo_medio_s) + 's' : ''}</span></div>`).join('')}</div>`;
  }
  if (d.boletins && d.boletins.length > 1) {
    h += `<div class="sec">Boletins anteriores</div><div class="card">${d.boletins.slice(0, 10).map(x => `<div class="hist-i"><div class="hist-d">${ddmm(x.data)}</div><div>${esc(mascara(x.manchete || ''))}</div></div>`).join('')}</div>`;
  }
  h += `<a class="btn ghost" href="${BOLETIM_URL}" target="_blank" rel="noopener">${IC.ext}Abrir boletim completo</a>`;
  return h;
}

function telaAjustes() {
  const M = metas(), d = S.data, push = d && d.push;
  const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  const temPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  let notif = '';
  if (push && push.tipo === 'ntfy') {
    notif = `<div class="field"><div class="hint">As notificações chegam pelo app <b>ntfy</b> (grátis). Instale, toque em <b>+</b> e assine o tópico abaixo:</div>
      <input class="input" readonly value="${esc(push.topico)}" onclick="this.select()"></div>`;
  } else if (!push || !push.vapid) {
    notif = `<div class="hint field">As notificações de venda e do boletim vão ser ligadas aqui assim que o servidor estiver pronto.</div>`;
  } else if (!standalone && /iphone|ipad/i.test(navigator.userAgent)) {
    notif = `<div class="alert warn">${IC.warn}<div>No iPhone, notificação só funciona com o app <b>na tela inicial</b>: toque em <b>Compartilhar</b> → <b>Adicionar à Tela de Início</b>, abra pelo ícone da Belor e volte aqui.</div></div>`;
  } else if (!temPush) {
    notif = `<div class="hint field">Este navegador não aceita notificação. No iPhone, use o Safari e adicione à tela inicial.</div>`;
  } else {
    const ativo = ls.get('belor_push_ok', false) && perm === 'granted';
    notif = `<div class="row"><span>Venda nova e boletim do dia</span><span>${ativo ? chip('good').replace('Bom', 'Ligado') : perm === 'denied' ? chip('bad').replace('Ruim', 'Bloqueado') : chip('na').replace('Sem dado', 'Desligado')}</span></div>
      ${perm === 'denied' ? `<div class="hint">Libere em Ajustes do iPhone → Notificações → Belor.</div>` : `<button class="btn mt8" data-act="push">${IC.bell}${ativo ? 'Testar notificação' : 'Ativar notificações'}</button>`}`;
  }
  const cartaoMeta = OCULTO()
    ? `<div class="card fade-in"><div class="card-h"><div class="card-t">Meta</div></div><div class="hint">As metas estão escondidas. Toque no <b>olho</b> lá em cima pra ver e editar.</div></div>`
    : `<div class="card fade-in"><div class="card-h"><div class="card-t">Meta</div></div>
      <div class="field"><label for="fMeta">Meta de faturamento de ${MES[ymd(hojeISO()).m - 1]}</label><input class="input num" id="fMeta" inputmode="numeric" value="${nf0.format(M.meta_mes)}"><div class="hint">Todas as cores do app (verde, amarelo, vermelho) são calculadas a partir dela. Vale pra este mês e os próximos, até você mudar de novo.</div></div>
      <div class="field"><label for="fTicket">Ticket médio alvo (R$)</label><input class="input num" id="fTicket" inputmode="numeric" value="${nf0.format(M.ticket)}"></div>
      <div class="field"><label for="fPa">Peças por atendimento alvo</label><input class="input num" id="fPa" inputmode="decimal" value="${dec1(M.pa)}"></div>
      <button class="btn" data-act="salvarMetas">Salvar metas</button></div>`;
  return `${cartaoMeta}
    <div class="card"><div class="card-h"><div class="card-t">Notificações</div></div>${notif}
      <div class="row mt12"><span>Som de venda (app aberto)</span><span>${S.somOn ? chip('good').replace('Bom', 'Ligado') : chip('na').replace('Sem dado', 'Desligado')}</span></div>
      <div class="btns"><button class="btn ghost mt8" data-act="somTestar">Testar som</button><button class="btn ghost mt8" data-act="somToggle">${S.somOn ? 'Desligar' : 'Ligar'} som</button></div>
      <div class="hint">Toca o "cha-ching" quando o app está aberto e entra uma venda. Com o app fechado, o iPhone usa o som padrão da notificação (o iOS não deixa trocar).</div></div>
    <div class="card"><div class="card-h"><div class="card-t">Conexão</div></div>
      <div class="row"><span>Último número da loja</span><span>${d && d.ultimo_envio ? horaDe(d.ultimo_envio) + ' (' + durTxt(minutosDesde(d.ultimo_envio)) + ')' : '—'}</span></div>
      <div class="row"><span>Dias na planilha</span><span>${d ? d.vendas.length : 0}</span></div>
      <div class="row"><span>App</span><span>v${VERSAO}${d && d.versao_servidor ? ' · servidor v' + d.versao_servidor : ''}</span></div>
      <button class="btn ghost mt12" data-act="sair">Sair (trocar código de acesso)</button></div>`;
}

function telaPin(erro) {
  return `<div class="pin fade-in">${IC.crown.replace('<svg', '<svg class="boot-crown" style="fill:var(--gold)"')}
    <h2>Painel da Belor</h2><p>Digite o código de acesso da loja.</p>
    <input class="input" id="fPin" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="código de acesso" style="text-align:center">
    <button class="btn mt12" data-act="entrar">Entrar</button><div class="err">${erro || ''}</div></div>`;
}

/* ---------------- render ---------------- */
const TABS = [['hoje', 'Hoje'], ['mes', 'Mês'], ['clientes', 'Clientes'], ['micro', 'Microdados'], ['boletim', 'Boletim'], ['ajustes', 'Ajustes']];
function render() {
  const app = $('#app');
  if (!S.pin) { app.innerHTML = telaPin(); return; }
  if (!S.data) {
    app.innerHTML = S.erro ? telaPin(S.erro === 'chave' ? 'Código não confere.' : 'Sem conexão. Tente de novo.') : `<div class="boot">${IC.crown.replace('<svg', '<svg class="boot-crown"')}<div class="boot-word">BELOR</div></div>`;
    return;
  }
  chartSeq = 0; for (const k in TIPS) delete TIPS[k];
  const corpo = { hoje: telaHoje, mes: telaMes, clientes: telaClientes, micro: telaMicro, boletim: telaBoletim, ajustes: telaAjustes }[S.tab] || telaHoje;
  const titulos = { hoje: ['Hoje', ''], mes: ['Mês', ''], clientes: ['Clientes', 'Cadastro, retorno e de onde eles vêm'], micro: ['Microdados', 'Cada número da loja com a meta dele'], boletim: ['Boletim', ''], ajustes: ['Ajustes', ''] };
  const nRuins = (() => { try { return microdados(contexto('mes')).filter(x => x.st === 'bad').length; } catch (e) { return 0; } })();
  const y0 = window.scrollY;
  app.innerHTML = `<div class="shell">${topo()}
    ${S.erro === 'rede' ? `<div class="alert warn">${IC.warn}<div>Sem conexão agora — mostrando os últimos números salvos.</div></div>` : ''}
    <h1 class="page">${titulos[S.tab][0]}</h1>${titulos[S.tab][1] ? `<p class="page-sub">${titulos[S.tab][1]}</p>` : '<div style="height:10px"></div>'}
    ${corpo()}</div>
    <nav class="tabs" aria-label="Seções"><div class="tabs-in">${TABS.map(([k, t]) => `<button class="tab" data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ''}><span class="tab-ic">${IC[k]}${k === 'micro' && nRuins ? `<span class="badge">${nRuins}</span>` : ''}</span>${t}</button>`).join('')}</div></nav>`;
  if (S._mesmaTela) window.scrollTo(0, y0);
  S._mesmaTela = false;
  ligarTips();
}

function toast(t) { let el = $('.toast'); if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); } el.textContent = t; el.classList.add('on'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('on'), 2600); }

/* ---------------- som de venda (app aberto) ---------------- */
let _ac = null;
function audioCtx() { try { if (!_ac) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) _ac = new AC(); } return _ac; } catch (e) { return null; } }
function destravarSom() { const ac = audioCtx(); if (ac && ac.state !== 'running') ac.resume().catch(() => {}); }
['touchend', 'click', 'keydown'].forEach(ev => document.addEventListener(ev, destravarSom, { passive: true }));
// "cha-ching" de caixa registradora, feito aqui mesmo (estalo + sino + moedas)
function somVenda() {
  const ac = audioCtx(); if (!ac) return false;
  if (ac.state !== 'running') ac.resume().catch(() => {});
  const t0 = ac.currentTime + 0.03, out = ac.createGain(); out.gain.value = 0.9; out.connect(ac.destination);
  const len = Math.floor(ac.sampleRate * 0.07), buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
  const ns = ac.createBufferSource(); ns.buffer = buf;
  const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.9;
  const gn = ac.createGain(); gn.gain.setValueAtTime(0.7, t0); gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);
  ns.connect(bp); bp.connect(gn); gn.connect(out); ns.start(t0);
  const sino = (f, ini, vol, dur) => [[1, 1], [2.76, 0.5], [5.4, 0.25], [8.9, 0.12]].forEach(([m, a]) => {
    const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.value = f * m;
    g.gain.setValueAtTime(0.0001, t0 + ini); g.gain.exponentialRampToValueAtTime(vol * a, t0 + ini + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ini + dur / Math.pow(m, 0.3));
    o.connect(g); g.connect(out); o.start(t0 + ini); o.stop(t0 + ini + dur + 0.1);
  });
  sino(2093, 0.09, 0.32, 1.1); sino(2637, 0.2, 0.28, 1.3);
  [0.5, 0.58, 0.69, 0.75, 0.88].forEach((ini, i) => sino(3520 + i * 310, ini, 0.07, 0.25));
  return true;
}
// Chamado depois de cada busca: se entrou venda nova hoje, toca.
function checarVendaNova() {
  const hoje = hojeISO(), r = linhaDe(hoje), n = r ? (r.vendas || 0) : 0;
  const ant = S.vendasVistas;
  S.vendasVistas = { dia: hoje, n };
  if (ant && ant.dia === hoje && n > ant.n && S.somOn && document.visibilityState === 'visible') somVenda();
}

/* ---------------- ações ---------------- */
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-tab],[data-per],[data-act],#btnSync,#btnOlho'); if (!t) return;
  if (t.id === 'btnOlho') { S.oculto = !S.oculto; ls.set('belor_oculto', S.oculto); S._mesmaTela = true; render(); toast(S.oculto ? 'Valores escondidos' : 'Valores à mostra'); return; }
  if (t.dataset.tab) { S.tab = t.dataset.tab; ls.set('belor_tab', S.tab); window.scrollTo(0, 0); render(); return; }
  if (t.dataset.per) { S.periodo = t.dataset.per; ls.set('belor_periodo', S.periodo); S._mesmaTela = true; render(); return; }
  if (t.id === 'btnSync') { await buscar(S.pin); S._mesmaTela = true; render(); toast(S.erro ? 'Não deu pra atualizar agora' : 'Atualizado'); return; }
  const act = t.dataset.act;
  if (act === 'entrar') {
    const pin = ($('#fPin').value || '').trim(); if (!pin) return;
    t.disabled = true; t.textContent = 'Entrando…';
    const ok = await buscar(pin);
    if (ok) { S.pin = pin; ls.set('belor_pin', pin); render(); } else { $('#app').innerHTML = telaPin(S.erro === 'chave' ? 'Código não confere.' : 'Sem conexão. Tente de novo.'); }
  }
  if (act === 'sair') { ls.del('belor_pin'); ls.del('belor_cache'); S.pin = null; S.data = null; render(); }
  if (act === 'tabela') { S.abertos.tabela = !S.abertos.tabela; S._mesmaTela = true; render(); }
  if (act === 'salvarMetas') {
    const p = s => num(String(s).replace(/[^\d,.]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    const meta = p($('#fMeta').value), tk = p($('#fTicket').value), pa = p($('#fPa').value);
    const mes = hojeISO().slice(0, 7);
    const valores = Object.assign({}, meta ? { meta_mes: meta } : {}, tk ? { ticket: tk } : {}, pa ? { pa } : {});
    S.metasLocais = { mes, valores }; ls.set('belor_metas', S.metasLocais);
    t.disabled = true; t.textContent = 'Salvando…';
    let ok = false;
    try {
      const r = await postar({ acao: 'config', config: Object.assign({}, tk ? { ticket: tk } : {}, pa ? { pa } : {}, meta ? { metas_mes: { [mes]: meta } } : {}) });
      ok = !!(r && r.ok);
    } catch (err) {}
    if (ok) { S.metasLocais = {}; ls.del('belor_metas'); await buscar(S.pin, true); toast('Metas salvas'); }
    else toast('Salvo só neste aparelho (sem conexão)');
    S._mesmaTela = true; render();
  }
  if (act === 'push') ativarPush();
  if (act === 'somTestar') { destravarSom(); toast(somVenda() ? 'Tocando… (sem som? veja se o iPhone está no silencioso)' : 'Este aparelho não toca som aqui'); }
  if (act === 'somToggle') { S.somOn = !S.somOn; ls.set('belor_som', S.somOn); if (S.somOn) { destravarSom(); somVenda(); } S._mesmaTela = true; render(); toast(S.somOn ? 'Som de venda ligado' : 'Som de venda desligado'); }
});
document.addEventListener('toggle', e => { const d = e.target; if (d.matches && d.matches('details.tipbox')) S.abertos['d_' + d.dataset.id] = d.open; }, true);

async function postar(corpo) {
  const r = await fetch(S.api, { method: 'POST', body: JSON.stringify(Object.assign({ k: S.pin }, corpo)), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow' });
  return r.json();
}

/* ---------------- notificações (Web Push) ---------------- */
function b64urlParaBytes(s) { const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); }
async function ativarPush() {
  try {
    const push = S.data && S.data.push; if (!push || !push.vapid) return toast('Notificações ainda não ligadas no servidor');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notificação não autorizada'); S._mesmaTela = true; render(); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlParaBytes(push.vapid) });
    const r = await postar({ acao: 'inscrever', sub: sub.toJSON(), aparelho: navigator.userAgent.slice(0, 120) });
    if (r && r.ok) { ls.set('belor_push_ok', true); ls.set('belor_push_ep', sub.endpoint); toast(typeof r.teste === 'number' && r.teste >= 200 && r.teste < 300 ? 'Pronto! Deve chegar uma notificação de teste' : 'Inscrito, mas o teste não saiu (' + r.teste + ')'); }
    else toast('Não deu pra ligar agora');
  } catch (e) { toast('Erro ao ativar: ' + e.message); }
  S._mesmaTela = true; render();
}
// Se o iPhone trocar a inscrição sozinho, avisa o servidor sem incomodar.
async function garantirPush() {
  try {
    const push = S.data && S.data.push;
    if (!push || !push.vapid || !('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlParaBytes(push.vapid) });
    if (sub && sub.endpoint !== ls.get('belor_push_ep', null)) {
      const r = await postar({ acao: 'inscrever', sub: sub.toJSON(), aparelho: navigator.userAgent.slice(0, 120), testar: false });
      if (r && r.ok) { ls.set('belor_push_ep', sub.endpoint); ls.set('belor_push_ok', true); }
    }
  } catch (e) {}
}

/* ---------------- início ---------------- */
async function iniciar() {
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (S.pin) { await buscar(S.pin, true); if (S.erro === 'chave') { ls.del('belor_pin'); S.pin = null; } render(); garantirPush(); }
  const atualizar = async (forcar) => {
    if (!S.pin || document.visibilityState !== 'visible') return;
    if (!forcar && Date.now() - S.ultimaBusca < 20000) return;
    await buscar(S.pin, true); S._mesmaTela = true;
    if (!document.querySelector('input:focus')) render();
  };
  setInterval(() => { if (Date.now() - S.ultimaBusca > 110000) atualizar(); }, 30000);
  document.addEventListener('visibilitychange', () => atualizar());
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', ev => {
    if (!ev.data) return;
    if (ev.data.tipo === 'abrir' && ev.data.tab) { S.tab = ev.data.tab; ls.set('belor_tab', S.tab); render(); atualizar(true); }
    if (ev.data.tipo === 'push') atualizar(true);
  });
}
iniciar();
})();
