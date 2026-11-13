/* =====================================================================
   PLD ITAPITANGA — Banco de dados Supabase com a mesma "cara" do Firebase
   ---------------------------------------------------------------------
   As páginas do sistema foram feitas para o Firebase Realtime Database
   (firebase.database().ref(...).on/set/update/push/transaction...).
   Este arquivo oferece exatamente essas mesmas funções, mas guardando tudo
   no Supabase do projeto PLD_Itapitanga (tabela pld_nos, uma linha por valor).

   - Tempo real: o aparelho escuta a tabela pld_log (WebSocket do Supabase).
     Se o WebSocket não funcionar (Smart TV antiga, rede que bloqueia),
     consulta o registro de mudanças a cada 1,5 s — a TV continua acompanhando.
   - Sem internet: as gravações ficam numa fila no aparelho e são enviadas,
     na ordem, quando a conexão volta.
   - ES5 puro: roda em Smart TVs antigas de qualquer marca.
   NÃO usa nem acessa nenhum banco de Almadina.
   ===================================================================== */
(function (W) {
  'use strict';
  if (W.__PLD_BANCO__) return;
  W.__PLD_BANCO__ = 1;

  var CFG = W.PLD_SUPABASE || {};
  var BASE = String(CFG.url || '').replace(/\/+$/, '');
  var CHAVE = String(CFG.chave || '');
  var CLIENTE = 'c' + new Date().getTime().toString(36) + Math.random().toString(36).slice(2, 10);
  var LOG = function () { try { if (W.console && W.PLD_DEBUG) console.log.apply(console, ['[PLD banco]'].concat([].slice.call(arguments))); } catch (e) {} };

  // ---------------------------------------------------------------- utilidades
  function norm(p) { return String(p == null ? '' : p).replace(/\/+/g, '/').replace(/^\/|\/$/g, ''); }
  function junta(a, b) { a = norm(a); b = norm(b); return a && b ? a + '/' + b : (a || b); }
  function sob(p, base) { return base === '' || p === base || p.indexOf(base + '/') === 0; }
  function ligados(a, b) { return sob(a, b) || sob(b, a); }
  function copia(v) { return v == null ? null : JSON.parse(JSON.stringify(v)); }
  function chaves(o) { var r = []; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r.push(k); return r; }
  function ehInt(k) { return /^(0|[1-9]\d{0,8})$/.test(k); }
  function cmpChave(a, b) {           // ordem das chaves igual ao Firebase: números primeiro, depois texto
    var ia = ehInt(a), ib = ehInt(b);
    if (ia && ib) return parseInt(a, 10) - parseInt(b, 10);
    if (ia) return -1; if (ib) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function agoraServidor() { return new Date().getTime() + OFFSET; }

  // valor -> folhas {caminho_relativo: valor_simples}
  function folhas(v) {
    var out = {}, tem = false;
    (function anda(x, rel) {
      if (x === undefined || x === null) return;
      if (typeof x === 'object' && !(x instanceof Array) && x['.sv'] !== undefined) {
        var sv = x['.sv'];
        if (sv === 'timestamp') { out[rel] = agoraServidor(); tem = true; }
        return;
      }
      if (typeof x === 'object') {
        var ks = x instanceof Array ? null : chaves(x);
        if (ks) { for (var i = 0; i < ks.length; i++) anda(x[ks[i]], rel ? rel + '/' + ks[i] : ks[i]); }
        else { for (var j = 0; j < x.length; j++) anda(x[j], rel ? rel + '/' + j : String(j)); }
        return;
      }
      if (typeof x === 'number' && !isFinite(x)) return;
      if (typeof x === 'function') return;
      out[rel] = x; tem = true;
    })(v, '');
    return tem ? out : null;
  }
  // objeto com chaves 0..n vira lista (mesma regra do Firebase)
  function talvezLista(o) {
    var ks = chaves(o), max = -1;
    if (!ks.length) return o;
    for (var i = 0; i < ks.length; i++) { if (!ehInt(ks[i])) return o; var n = parseInt(ks[i], 10); if (n > max) max = n; }
    if (ks.length * 2 <= max) return o;
    var arr = []; for (var j = 0; j <= max; j++) arr.push(o[j] === undefined ? null : o[j]);
    return arr;
  }
  function montar(mapa) {            // {rel: valor} -> valor (null se vazio)
    var ks = chaves(mapa);
    if (!ks.length) return null;
    if (mapa[''] !== undefined) return mapa[''];
    var raiz = {};
    for (var i = 0; i < ks.length; i++) {
      var partes = ks[i].split('/'), o = raiz;
      for (var j = 0; j < partes.length - 1; j++) {
        if (o[partes[j]] === null || typeof o[partes[j]] !== 'object') o[partes[j]] = {};
        o = o[partes[j]];
      }
      o[partes[partes.length - 1]] = mapa[ks[i]];
    }
    (function conv(o) { for (var k in o) if (o[k] && typeof o[k] === 'object') { conv(o[k]); o[k] = talvezLista(o[k]); } })(raiz);
    return talvezLista(raiz);
  }

  // ---------------------------------------------------------------- cache local
  var DADOS = {};          // caminho completo -> valor simples (só das áreas sincronizadas)
  var AREAS = [];          // {p, pronto, espera:[]}
  var OUVINTES = [];       // {p, q, tipo, cb, ctx, ultimo, vistos}
  var PENDENTES = [];      // gravações locais ainda não confirmadas {mudancas:{caminho: folhas|null}}
  var OFFSET = 0, CONECTADO = false, ULT_SEQ = null;

  function mapaDe(p) {
    var r = {}, pre = p + '/';
    for (var k in DADOS) {
      if (k === p) r[''] = DADOS[k];
      else if (p === '' || k.indexOf(pre) === 0) r[p === '' ? k : k.slice(pre.length)] = DADOS[k];
    }
    return r;
  }
  function valorDe(p) { return montar(mapaDe(p)); }
  function trocaLocal(p, fl) {        // grava no cache como o banco faria
    var partes = p.split('/'), anc = '';
    for (var i = 0; i < partes.length - 1; i++) { anc = anc ? anc + '/' + partes[i] : partes[i]; if (DADOS[anc] !== undefined) delete DADOS[anc]; }
    var pre = p + '/';
    for (var k in DADOS) if (k === p || k.indexOf(pre) === 0) delete DADOS[k];
    if (fl) for (var r in fl) DADOS[r === '' ? p : p + '/' + r] = fl[r];
  }
  function areaDe(p) { for (var i = 0; i < AREAS.length; i++) if (sob(p, AREAS[i].p)) return AREAS[i]; return null; }
  function sincronizado(p) { var a = areaDe(p); return !!(a && a.pronto); }

  // ---------------------------------------------------------------- comunicação HTTP (XHR: funciona em TV antiga)
  function http(metodo, caminho, corpo, extra) {
    return new Promise(function (ok, falha) {
      var x;
      try { x = new XMLHttpRequest(); x.open(metodo, BASE + caminho, true); } catch (e) { return falha({ rede: true, e: e }); }
      x.setRequestHeader('apikey', CHAVE);
      x.setRequestHeader('Authorization', 'Bearer ' + CHAVE);
      x.setRequestHeader('Content-Type', 'application/json');
      if (extra) for (var h in extra) x.setRequestHeader(h, extra[h]);
      x.timeout = 20000;
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        if (x.status >= 200 && x.status < 300) {
          var r = null; try { r = x.responseText ? JSON.parse(x.responseText) : null; } catch (e) {}
          marcarRede(true); ok(r);
        } else if (x.status === 0 || x.status >= 500 || x.status === 429) { marcarRede(false); falha({ rede: true, status: x.status }); }
        else { var m = x.responseText; falha({ rede: false, status: x.status, msg: m, code: x.status === 401 || x.status === 403 ? 'PERMISSION_DENIED' : 'erro' }); }
      };
      x.ontimeout = function () { marcarRede(false); falha({ rede: true, timeout: true }); };
      try { x.send(corpo == null ? null : JSON.stringify(corpo)); } catch (e) { falha({ rede: true, e: e }); }
    });
  }
  function rpc(nome, args) { return http('POST', '/rest/v1/rpc/' + nome, args || {}); }

  // busca todas as linhas de um caminho (função pld_ler do banco, 1000 por vez)
  function buscarLinhas(p) {
    var linhas = [];
    function pede(desde) {
      return rpc('pld_ler', { p: p, desde: desde }).then(function (r) {
        r = r || [];
        for (var i = 0; i < r.length; i++) linhas.push(r[i]);
        return r.length === 1000 ? pede(desde + 1000) : linhas;
      });
    }
    return pede(0);
  }

  // ---------------------------------------------------------------- estado de conexão
  var redeOk = null;
  function marcarRede(ok) {
    if (redeOk === ok) return;
    redeOk = ok;
    var novo = !!ok;
    if (novo !== CONECTADO) { CONECTADO = novo; avisarInfo(); if (novo) { verLog(); enviarFila(); } }
  }

  // ---------------------------------------------------------------- sincronizar áreas
  var inicio = null;      // pega o último número do registro ANTES de ler os dados (não perde mudanças)
  function iniciar() {
    if (inicio) return inicio;
    inicio = new Promise(function (ok) {
      function tenta() {
        http('GET', '/rest/v1/pld_log?select=seq&order=seq.desc&limit=1').then(function (r) {
          ULT_SEQ = r && r.length ? r[0].seq : 0; ok();
        }, function () { setTimeout(tenta, 3000); });
      }
      tenta();
    });
    inicio.then(function () { relogio(); conectarTempoReal(); setInterval(verLog, 20000); setInterval(relogio, 300000); });
    return inicio;
  }
  function garantir(p) {
    var a = areaDe(p);
    if (a) return a.pronto ? Promise.resolve() : a.promessa;
    a = { p: p, pronto: false };
    // áreas menores dentro desta passam a fazer parte dela
    for (var i = AREAS.length - 1; i >= 0; i--) if (sob(AREAS[i].p, p) && AREAS[i].pronto) AREAS.splice(i, 1);
    AREAS.push(a);
    a.promessa = iniciar().then(function () { return carregar(p); }).then(function () { a.pronto = true; });
    return a.promessa;
  }
  function carregar(p) {
    return new Promise(function (ok) {
      function tenta() {
        buscarLinhas(p).then(function (linhas) {
          var fl = {};
          for (var i = 0; i < linhas.length; i++) fl[linhas[i].caminho === p ? '' : (p === '' ? linhas[i].caminho : linhas[i].caminho.slice(p.length + 1))] = linhas[i].valor;
          trocaLocal(p, chaves(fl).length ? fl : null);
          reaplicarPendentes(p);
          ok(); avisar(p);
        }, function (e) { if (e && !e.rede) { LOG('erro ao ler', p, e); } setTimeout(tenta, e && e.rede ? 2500 : 8000); });
      }
      tenta();
    });
  }
  function reaplicarPendentes(p) {
    for (var i = 0; i < PENDENTES.length; i++) {
      var m = PENDENTES[i].mudancas;
      for (var c in m) if (ligados(c, p)) trocaLocal(c, m[c]);
    }
  }

  // ---------------------------------------------------------------- registro de mudanças (tempo real)
  var buscandoLog = false, aRecarregar = {}, timerRecarga = null;
  function processarLog(lista) {
    for (var i = 0; i < lista.length; i++) {
      var e = lista[i];
      if (ULT_SEQ !== null && e.seq <= ULT_SEQ) continue;
      ULT_SEQ = e.seq;
      for (var j = 0; j < AREAS.length; j++) {
        var a = AREAS[j]; if (!a.pronto) continue;
        if (ligados(e.caminho, a.p)) aRecarregar[sob(e.caminho, a.p) ? e.caminho : a.p] = 1;
      }
    }
    if (!timerRecarga) timerRecarga = setTimeout(recarregarMarcados, 30);
  }
  function recarregarMarcados() {
    timerRecarga = null;
    var lista = chaves(aRecarregar); aRecarregar = {};
    // tira caminhos que já estão dentro de outro da lista
    lista.sort(function (a, b) { return a.length - b.length; });
    var finais = [];
    for (var i = 0; i < lista.length; i++) { var dentro = false; for (var j = 0; j < finais.length; j++) if (sob(lista[i], finais[j])) dentro = true; if (!dentro) finais.push(lista[i]); }
    for (var k = 0; k < finais.length; k++) carregar(finais[k]);
  }
  function verLog() {
    if (buscandoLog || ULT_SEQ === null) return;
    buscandoLog = true;
    http('GET', '/rest/v1/pld_log?select=seq,caminho&seq=gt.' + ULT_SEQ + '&order=seq&limit=1000').then(function (r) {
      buscandoLog = false; if (r && r.length) processarLog(r);
    }, function () { buscandoLog = false; });
  }

  // WebSocket do Supabase Realtime (protocolo Phoenix vsn 1.0.0, igual ao supabase-js)
  var ws = null, wsOk = false, wsRef = 1, wsBeat = null, wsTentativa = 0, poll = null;
  function conectarTempoReal() {
    ligarPolling();
    if (!W.WebSocket || !BASE) return;
    try { ws = new W.WebSocket(BASE.replace(/^http/, 'ws') + '/realtime/v1/websocket?apikey=' + encodeURIComponent(CHAVE) + '&vsn=1.0.0'); }
    catch (e) { return; }
    ws.onopen = function () {
      wsTentativa = 0;
      enviaWs({ topic: 'realtime:pld-itapitanga', event: 'phx_join', ref: '1', join_ref: '1', payload: {
        config: { broadcast: { ack: false, self: false }, presence: { key: '', enabled: false },
          postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'pld_log' }], private: false },
        access_token: CHAVE } });
      clearInterval(wsBeat);
      wsBeat = setInterval(function () { enviaWs({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++wsRef) }); }, 25000);
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.event === 'phx_reply' && m.ref === '1') {
        wsOk = !!(m.payload && m.payload.status === 'ok');
        LOG('tempo real', wsOk ? 'ligado' : 'recusado', m.payload);
        ligarPolling(); if (wsOk) verLog();
      } else if (m.event === 'postgres_changes' && m.payload && m.payload.data) {
        var rec = m.payload.data.record;
        if (rec && rec.seq != null) {
          if (ULT_SEQ !== null && rec.seq > ULT_SEQ + 1) verLog();      // pulou algum: busca o que faltou
          else processarLog([{ seq: rec.seq, caminho: rec.caminho }]);
        }
      } else if (m.event === 'phx_error' || m.event === 'phx_close' || m.event === 'system' && m.payload && m.payload.status === 'error') {
        wsOk = false; ligarPolling();
      }
    };
    ws.onclose = function () {
      wsOk = false; clearInterval(wsBeat); ligarPolling();
      var espera = Math.min(30000, 2000 * Math.pow(2, wsTentativa++));
      setTimeout(conectarTempoReal, espera);
    };
    ws.onerror = function () {};
  }
  function enviaWs(m) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); } catch (e) {} }
  function ligarPolling() {          // sem WebSocket: confere o registro a cada 1,5 s
    clearInterval(poll);
    poll = setInterval(verLog, wsOk ? 15000 : 1500);
  }

  // relógio do servidor
  function relogio() {
    var t0 = new Date().getTime();
    rpc('pld_agora').then(function (srv) {
      var t1 = new Date().getTime();
      if (typeof srv === 'number') { OFFSET = Math.round(srv - (t0 + t1) / 2); avisarInfo(); }
    }, function () {});
  }

  // ---------------------------------------------------------------- fila de gravação (funciona sem internet)
  var FILA = [], enviando = false, CHAVE_FILA = 'pld_fila_banco';
  try { var salva = JSON.parse(W.localStorage.getItem(CHAVE_FILA) || '[]'); if (salva && salva.length) FILA = salva; } catch (e) {}
  function salvarFila() {
    try { var s = []; for (var i = 0; i < FILA.length; i++) if (FILA[i].rpc !== 'pld_cas') s.push({ rpc: FILA[i].rpc, args: FILA[i].args }); W.localStorage.setItem(CHAVE_FILA, JSON.stringify(s)); } catch (e) {}
  }
  function gravar(mudancas) {         // {caminho: folhas|null}
    var pend = { mudancas: mudancas };
    PENDENTES.push(pend);
    var afetados = [];
    for (var c in mudancas) { if (areaDe(c) || sincronizadoAlgum(c)) trocaLocal(c, mudancas[c]); afetados.push(c); }
    for (var i = 0; i < afetados.length; i++) avisar(afetados[i]);
    var cs = chaves(mudancas), item;
    if (cs.length === 1) item = { rpc: 'pld_set', args: { p: cs[0], folhas: mudancas[cs[0]] } };
    else item = { rpc: 'pld_update', args: { mudancas: mudancas } };
    return enfileirar(item, pend);
  }
  function sincronizadoAlgum(c) { for (var i = 0; i < AREAS.length; i++) if (sob(AREAS[i].p, c)) return true; return false; }
  function enfileirar(item, pend) {
    return new Promise(function (ok, falha) {
      item.ok = ok; item.falha = falha; item.pend = pend;
      FILA.push(item); salvarFila(); enviarFila();
    });
  }
  function enviarFila() {
    if (enviando || !FILA.length) return;
    enviando = true;
    var item = FILA[0];
    rpc(item.rpc, item.args).then(function (r) {
      FILA.shift(); salvarFila(); enviando = false;
      tirarPendente(item.pend);
      if (item.ok) item.ok(r);
      verLog(); enviarFila();
    }, function (e) {
      enviando = false;
      if (e && e.rede) { setTimeout(enviarFila, 2500); return; }       // sem internet: tenta de novo
      FILA.shift(); salvarFila(); tirarPendente(item.pend);
      LOG('gravação recusada', item, e);
      if (item.pend) for (var c in item.pend.mudancas) recarregarArea(c);
      if (item.falha) item.falha(erroFb(e));
      enviarFila();
    });
  }
  function tirarPendente(p) { var i = PENDENTES.indexOf(p); if (i >= 0) PENDENTES.splice(i, 1); }
  function recarregarArea(c) { var a = areaDe(c); if (a && a.pronto) carregar(sob(c, a.p) ? c : a.p); }
  function erroFb(e) { var x = new Error((e && e.msg) || 'Falha ao gravar no banco'); x.code = (e && e.code) || 'erro'; return x; }

  // ---------------------------------------------------------------- "ao desconectar" (onDisconnect)
  var AO_SAIR = {}, sinalTimer = null;
  function sinal(saindo) {
    if (!BASE) return;
    if (saindo) {
      try {
        if (W.fetch) W.fetch(BASE + '/rest/v1/rpc/pld_sinal', { method: 'POST', keepalive: true,
          headers: { apikey: CHAVE, Authorization: 'Bearer ' + CHAVE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ cli: CLIENTE, saindo: true }) });
        else { var x = new XMLHttpRequest(); x.open('POST', BASE + '/rest/v1/rpc/pld_sinal', false); x.setRequestHeader('apikey', CHAVE); x.setRequestHeader('Authorization', 'Bearer ' + CHAVE); x.setRequestHeader('Content-Type', 'application/json'); x.send(JSON.stringify({ cli: CLIENTE, saindo: true })); }
      } catch (e) {}
      return;
    }
    rpc('pld_sinal', { cli: CLIENTE, saindo: false }).then(null, function () {});
  }
  function ligarSinal() {
    if (sinalTimer) return;
    sinal(false);
    sinalTimer = setInterval(function () { sinal(false); }, 15000);
  }
  var saiu = false;
  function aoSair() { if (saiu) return; saiu = true; if (chaves(AO_SAIR).length) sinal(true); }
  if (W.addEventListener) { W.addEventListener('pagehide', aoSair); W.addEventListener('beforeunload', aoSair); }
  function OnDisconnect(p) { this._p = p; }
  OnDisconnect.prototype._registra = function (fl) {
    var p = this._p; AO_SAIR[p] = 1; ligarSinal();
    return iniciar().then(function () { return rpc('pld_ao_desconectar', { cli: CLIENTE, p: p, folhas: fl, cancelar: false }); }).then(function () {}, function (e) { throw erroFb(e); });
  };
  OnDisconnect.prototype.set = function (v, cb) { var pr = this._registra(folhas(v)); cbDe(pr, cb); return pr; };
  OnDisconnect.prototype.remove = function (cb) { var pr = this._registra(null); cbDe(pr, cb); return pr; };
  OnDisconnect.prototype.update = function (obj, cb) {
    var self = this, prs = [];
    for (var k in obj) prs.push(new OnDisconnect(junta(self._p, k))._registra(folhas(obj[k])));
    var pr = Promise.all(prs).then(function () {}); cbDe(pr, cb); return pr;
  };
  OnDisconnect.prototype.cancel = function (cb) {
    var p = this._p; delete AO_SAIR[p];
    var pr = rpc('pld_ao_desconectar', { cli: CLIENTE, p: p, folhas: null, cancelar: true }).then(function () {}, function () {});
    cbDe(pr, cb); return pr;
  };
  function cbDe(pr, cb) { if (typeof cb === 'function') pr.then(function () { cb(null); }, function (e) { cb(e); }); }

  // ---------------------------------------------------------------- Snapshot (igual ao DataSnapshot)
  function Snapshot(ref, valor, ordem) { this.ref = ref; this.key = ref.key; this._v = valor; this._ordem = ordem; }
  Snapshot.prototype.val = function () { return copia(this._v); };
  Snapshot.prototype.exportVal = Snapshot.prototype.val;
  Snapshot.prototype.toJSON = Snapshot.prototype.val;
  Snapshot.prototype.exists = function () { return this._v !== null && this._v !== undefined; };
  Snapshot.prototype.child = function (c) {
    var v = this._v, partes = norm(c).split('/');
    for (var i = 0; i < partes.length && v != null; i++) v = typeof v === 'object' ? (v[partes[i]] === undefined ? null : v[partes[i]]) : null;
    return new Snapshot(this.ref.child(c), v === undefined ? null : v);
  };
  Snapshot.prototype.hasChild = function (c) { return this.child(c).exists(); };
  Snapshot.prototype.hasChildren = function () { return this.numChildren() > 0; };
  Snapshot.prototype._chaves = function () {
    if (this._ordem) return this._ordem.slice();
    var v = this._v; if (!v || typeof v !== 'object') return [];
    var ks = chaves(v); ks.sort(cmpChave); return ks;
  };
  Snapshot.prototype.numChildren = function () { return this._chaves().length; };
  Object.defineProperty && Object.defineProperty(Snapshot.prototype, 'size', { get: function () { return this.numChildren(); } });
  Snapshot.prototype.forEach = function (fn) {
    var ks = this._chaves();
    for (var i = 0; i < ks.length; i++) if (fn(this.child(ks[i])) === true) return true;
    return false;
  };
  Snapshot.prototype.getPriority = function () { return null; };

  // ---------------------------------------------------------------- consultas (orderByChild/limitToLast/equalTo)
  function resultado(p, q) {
    var v = valorDe(p);
    if (!q) return { v: v };
    var filhos = v && typeof v === 'object' ? v : {};
    var ks = chaves(filhos);
    function campo(k) {
      if (q.ordem === 'key') return k;
      if (q.ordem === 'value') return filhos[k];
      var x = filhos[k]; if (q.campo) { var ps = q.campo.split('/'); for (var i = 0; i < ps.length && x != null; i++) x = typeof x === 'object' ? x[ps[i]] : null; }
      return x === undefined ? null : x;
    }
    function rank(x) { return x === null ? 0 : x === false ? 1 : x === true ? 2 : typeof x === 'number' ? 3 : typeof x === 'string' ? 4 : 5; }
    function cmp(a, b) {
      var va = campo(a), vb = campo(b), ra = rank(va), rb = rank(vb);
      if (q.ordem === 'key') return cmpChave(a, b);
      if (ra !== rb) return ra - rb;
      if (ra === 3 || ra === 4) { if (va < vb) return -1; if (va > vb) return 1; }
      return cmpChave(a, b);
    }
    if (q.ordem) ks.sort(cmp); else ks.sort(cmpChave);
    if (q.igual !== undefined) ks = ks.filter(function (k) { return campo(k) === q.igual; });
    if (q.inicio !== undefined) ks = ks.filter(function (k) { var c = campo(k); return c !== null && c >= q.inicio; });
    if (q.fim !== undefined) ks = ks.filter(function (k) { var c = campo(k); return c !== null && c <= q.fim; });
    if (q.ultimos) ks = ks.slice(Math.max(0, ks.length - q.ultimos));
    if (q.primeiros) ks = ks.slice(0, q.primeiros);
    var out = null;
    if (ks.length) { out = {}; for (var i = 0; i < ks.length; i++) out[ks[i]] = filhos[ks[i]]; }
    return { v: out, ordem: ks };
  }

  // ---------------------------------------------------------------- avisar ouvintes
  function avisar(caminho) {
    for (var i = 0; i < OUVINTES.length; i++) {
      var o = OUVINTES[i];
      if (o.info || !o.pronto) continue;
      if (caminho === null || ligados(o.p, caminho)) disparar(o);
    }
  }
  function disparar(o) {
    if (o.info) {
      var v = o.p === '.info/connected' ? CONECTADO : o.p === '.info/serverTimeOffset' ? OFFSET : null;
      var sv = JSON.stringify(v); if (sv === o.ultimo) return; o.ultimo = sv;
      chama(o, new Snapshot(o.ref, v));
      return;
    }
    var r = resultado(o.p, o.q), s = JSON.stringify(r.v) + '|' + (r.ordem ? r.ordem.join(',') : '');
    if (o.tipo === 'value') {
      if (s === o.ultimo) return; o.ultimo = s;
      chama(o, new Snapshot(o.ref, r.v, r.ordem));
    } else if (o.tipo === 'child_added' || o.tipo === 'child_changed' || o.tipo === 'child_removed') {
      var atual = {}, ks = r.ordem || (r.v ? chaves(r.v).sort(cmpChave) : []);
      for (var i = 0; i < ks.length; i++) atual[ks[i]] = JSON.stringify(r.v[ks[i]]);
      var antes = o.vistos || {};
      if (o.tipo === 'child_added') { for (var a = 0; a < ks.length; a++) if (antes[ks[a]] === undefined) chama(o, new Snapshot(o.ref.child(ks[a]), copia(r.v[ks[a]]))); }
      if (o.tipo === 'child_changed') { for (var b = 0; b < ks.length; b++) if (antes[ks[b]] !== undefined && antes[ks[b]] !== atual[ks[b]]) chama(o, new Snapshot(o.ref.child(ks[b]), copia(r.v[ks[b]]))); }
      if (o.tipo === 'child_removed') { for (var k in antes) if (atual[k] === undefined) chama(o, new Snapshot(o.ref.child(k), JSON.parse(antes[k]))); }
      o.vistos = atual;
    }
  }
  function chama(o, snap) { try { o.cb.call(o.ctx || null, snap); } catch (e) { if (W.console) console.error(e); } }
  function avisarInfo() { for (var i = 0; i < OUVINTES.length; i++) if (OUVINTES[i].info) disparar(OUVINTES[i]); }

  // ---------------------------------------------------------------- Reference / Query
  function Ref(p, q) {
    this._p = norm(p); this._q = q || null;
    var partes = this._p ? this._p.split('/') : [];
    this.key = partes.length ? partes[partes.length - 1] : null;
    this.path = { toString: (function (x) { return function () { return '/' + x; }; })(this._p) };
  }
  Ref.prototype.toString = function () { return BASE + '/' + this._p; };
  Ref.prototype.child = function (c) { return new Ref(junta(this._p, c)); };
  Object.defineProperty && Object.defineProperty(Ref.prototype, 'parent', { get: function () { if (!this._p) return null; var i = this._p.lastIndexOf('/'); return new Ref(i < 0 ? '' : this._p.slice(0, i)); } });
  Object.defineProperty && Object.defineProperty(Ref.prototype, 'root', { get: function () { return new Ref(''); } });
  Object.defineProperty && Object.defineProperty(Ref.prototype, 'ref', { get: function () { return new Ref(this._p); } });
  Ref.prototype.isEqual = function (o) { return !!o && o._p === this._p && JSON.stringify(o._q) === JSON.stringify(this._q); };
  function qcom(r, mud) { var q = {}; var b = r._q || {}; for (var k in b) q[k] = b[k]; for (var m in mud) q[m] = mud[m]; return new Ref(r._p, q); }
  Ref.prototype.orderByChild = function (c) { return qcom(this, { ordem: 'child', campo: norm(c) }); };
  Ref.prototype.orderByKey = function () { return qcom(this, { ordem: 'key' }); };
  Ref.prototype.orderByValue = function () { return qcom(this, { ordem: 'value' }); };
  Ref.prototype.orderByPriority = function () { return qcom(this, { ordem: 'key' }); };
  Ref.prototype.limitToLast = function (n) { return qcom(this, { ultimos: n }); };
  Ref.prototype.limitToFirst = function (n) { return qcom(this, { primeiros: n }); };
  Ref.prototype.equalTo = function (v) { return qcom(this, { igual: v }); };
  Ref.prototype.startAt = function (v) { return qcom(this, { inicio: v }); };
  Ref.prototype.endAt = function (v) { return qcom(this, { fim: v }); };

  Ref.prototype.on = function (tipo, cb, erro, ctx) {
    if (typeof erro === 'object' && erro && !ctx) { ctx = erro; erro = null; }
    var o = { p: this._p, q: this._q, tipo: tipo, cb: cb, ctx: ctx, ref: this, ultimo: null, vistos: null, pronto: false,
              info: this._p.indexOf('.info/') === 0 };
    OUVINTES.push(o);
    if (o.info) { o.pronto = true; iniciar(); setTimeout(function () { disparar(o); }, 0); return cb; }
    garantir(this._p).then(function () { if (OUVINTES.indexOf(o) >= 0) { o.pronto = true; disparar(o); } });
    return cb;
  };
  Ref.prototype.off = function (tipo, cb) {
    var qs = JSON.stringify(this._q);
    for (var i = OUVINTES.length - 1; i >= 0; i--) {
      var o = OUVINTES[i];
      if (o.p !== this._p || JSON.stringify(o.q) !== qs) continue;
      if (tipo && o.tipo !== tipo) continue;
      if (cb && o.cb !== cb) continue;
      OUVINTES.splice(i, 1);
    }
  };
  Ref.prototype.once = function (tipo, cb, erro, ctx) {
    var self = this;
    tipo = tipo || 'value';
    var pr;
    if (this._p.indexOf('.info/') === 0) pr = Promise.resolve(new Snapshot(this, this._p === '.info/connected' ? CONECTADO : OFFSET));
    else pr = garantir(this._p).then(function () { var r = resultado(self._p, self._q); return new Snapshot(self, r.v, r.ordem); });
    if (typeof cb === 'function') pr.then(function (s) { cb.call(ctx || null, s); }, function (e) { if (typeof erro === 'function') erro(e); });
    return pr;
  };
  Ref.prototype.get = function () { return this.once('value'); };

  Ref.prototype.set = function (v, cb) {
    var m = {}; m[this._p] = folhas(v);
    var pr = gravar(m); cbDe(pr, cb); return pr.then(function () {});
  };
  Ref.prototype.remove = function (cb) { return this.set(null, cb); };
  Ref.prototype.update = function (obj, cb) {
    var m = {}, tem = false;
    for (var k in obj) { if (!Object.prototype.hasOwnProperty.call(obj, k)) continue; m[junta(this._p, k)] = folhas(obj[k]); tem = true; }
    var pr = tem ? gravar(m) : Promise.resolve(); cbDe(pr, cb); return pr.then(function () {});
  };
  Ref.prototype.setWithPriority = function (v, pri, cb) { return this.set(v, cb); };

  // chave do push: igual ao Firebase (ordem de tempo, 20 caracteres)
  var PUSH_CH = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz', ultPush = 0, ultRand = [];
  function chavePush() {
    var agora = agoraServidor(), dup = agora === ultPush, i; ultPush = agora;
    var t = new Array(8);
    for (i = 7; i >= 0; i--) { t[i] = PUSH_CH.charAt(agora % 64); agora = Math.floor(agora / 64); }
    var id = t.join('');
    if (!dup) { for (i = 0; i < 12; i++) ultRand[i] = Math.floor(Math.random() * 64); }
    else { for (i = 11; i >= 0 && ultRand[i] === 63; i--) ultRand[i] = 0; ultRand[i]++; }
    for (i = 0; i < 12; i++) id += PUSH_CH.charAt(ultRand[i]);
    return id;
  }
  Ref.prototype.push = function (v, cb) {
    var filho = this.child(chavePush());
    var pr = v === undefined ? Promise.resolve() : filho.set(v);
    cbDe(pr, cb);
    var simples = new Ref(filho._p);                 // o "await" devolve uma referência comum (não "thenable")
    filho.then = function (a, b) { return pr.then(function () { return simples; }).then(a, b); };
    filho['catch'] = function (b) { return pr.then(null, b); };
    return filho;
  };

  // transação: lê, calcula e só grava se ninguém mudou no meio (voto único, sorteio, cronômetro)
  Ref.prototype.transaction = function (fn, aoFim, aplicarLocal) {
    var self = this, p = this._p;
    var pr = new Promise(function (ok, falha) {
      var tentativas = 0;
      function rodar(atual, esperadoFl) {
        var novo;
        try { novo = fn(copia(atual)); } catch (e) { return falha(e); }
        if (novo === undefined) return ok({ committed: false, snapshot: new Snapshot(self, atual) });
        var fl = folhas(novo);
        rpc('pld_cas', { p: p, esperado: esperadoFl, folhas: fl }).then(function (r) {
          if (r && r.ok) {
            trocaLocal(p, fl); avisar(p); verLog();
            ok({ committed: true, snapshot: new Snapshot(self, montar(fl || {})) });
          } else {
            var srv = r && r.atual ? r.atual : null;
            trocaLocal(p, srv); avisar(p);
            if (++tentativas > 25) return ok({ committed: false, snapshot: new Snapshot(self, montar(srv || {})) });
            rodar(montar(srv || {}), srv);
          }
        }, function (e) {
          if (e && e.rede) return setTimeout(function () { comecar(); }, 2500);    // sem internet: tenta quando voltar
          falha(erroFb(e));
        });
      }
      function comecar() {
        garantir(p).then(function () {
          var m = mapaDe(p);
          rodar(montar(m), chaves(m).length ? m : null);
        });
      }
      comecar();
    });
    if (typeof aoFim === 'function') pr.then(function (r) { aoFim(null, r.committed, r.snapshot); }, function (e) { aoFim(e, false, null); });
    return pr;
  };
  Ref.prototype.onDisconnect = function () { return new OnDisconnect(this._p); };

  // ---------------------------------------------------------------- firebase.* (mesma interface)
  var DB = {
    ref: function (p) { return new Ref(p || ''); },
    refFromURL: function (u) { return new Ref(String(u).replace(/^https?:\/\/[^/]+/, '')); },
    goOnline: function () {}, goOffline: function () {},
    app: null
  };
  var APP = { name: '[DEFAULT]', options: {}, database: function () { return DB; } };
  DB.app = APP;
  var fb = {
    apps: [],
    SDK_VERSION: 'pld-supabase-1',
    initializeApp: function (cfg) { if (!fb.apps.length) { APP.options = cfg || {}; fb.apps.push(APP); } return APP; },
    app: function () { return APP; }
  };
  fb.database = function () { if (!fb.apps.length) fb.apps.push(APP); return DB; };
  fb.database.ServerValue = { TIMESTAMP: { '.sv': 'timestamp' } };
  fb.database.enableLogging = function () {};
  W.firebase = fb;

  // diagnóstico (console: PLD_BANCO.estado())
  W.PLD_BANCO = {
    estado: function () { return { conectado: CONECTADO, tempoReal: wsOk, ultimoRegistro: ULT_SEQ, areas: AREAS.map(function (a) { return a.p + (a.pronto ? '' : ' (carregando)'); }), fila: FILA.length, ouvintes: OUVINTES.length, relogio: OFFSET }; },
    projeto: BASE
  };
  if (!BASE || !CHAVE) { if (W.console) console.error('PLD: banco de dados não configurado (js/pld-config.js).'); return; }
  iniciar();
  if (FILA.length) enviarFila();
})(window);
