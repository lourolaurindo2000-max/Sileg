/* =====================================================================
   BANCO DE DADOS DO PLD ITAPITANGA: Supabase (projeto PLD_Itapitanga)
   O endereço e a chave ficam em js/pld-config.js (o Vercel preenche na publicação).
   O js/pld-banco.js oferece às páginas as mesmas funções do Firebase, mas grava no Supabase.
   NÃO usa nenhum banco de Almadina.
   ===================================================================== */
window.PLD_FIREBASE = { apiKey: "supabase", databaseURL: "supabase" };   // só para as páginas saberem que há banco

/* PLD ITAPITANGA — separa os dados salvos no navegador (login, aparelho, modo TV) dos de Almadina,
   que fica no mesmo endereço lourolaurindo2000-max.github.io. Todas as chaves ganham o prefixo "itp:". */
(function () {
  try {
    var P = 'itp:', SP = Storage.prototype;
    if (SP.__itp) return; SP.__itp = 1;
    var g = SP.getItem, s = SP.setItem, r = SP.removeItem, k = SP.key;
    SP.getItem = function (x) { return g.call(this, P + x); };
    SP.setItem = function (x, v) { return s.call(this, P + x, v); };
    SP.removeItem = function (x) { return r.call(this, P + x); };
    SP.key = function (i) { var x = k.call(this, i); return x && x.indexOf(P) === 0 ? x.slice(P.length) : null; };
  } catch (e) {}
})();
/* Compatibilidade com navegadores antigos de Smart TV (Hisense VIDAA, Samsung/LG antigas etc.)
 *
 * - Navegador moderno: nada muda (Firebase 10 e o código normal da página).
 * - Navegador antigo: carrega o Firebase 8 (que funciona em navegadores antigos, mesma forma de uso),
 *   os "polyfills" (core-js) e, se a página tiver código moderno que a TV não entende,
 *   converte esse código para JavaScript antigo (Babel) e guarda a conversão para abrir rápido nas próximas vezes.
 *
 * Uso na página:
 *   <script src="js/tv-compat.js"></script>                 (no <head>, antes de tudo)
 *   <script>__fb()</script>                                 (no lugar das tags do Firebase)
 *   <script id="app-x">window.__ok_x=1; ...código...</script>
 *   <script>__es5('app-x','__ok_x')</script>                (logo depois do bloco)
 *
 * Teste num computador: abra a página com ?es5 no endereço para forçar o modo de TV antiga.
 */
(function () {
    var W = window, D = document;
    var forcar = /[?&]es5\b/.test(location.search || '');
    try { if (W.top !== W.self && /[?&]es5\b/.test(W.top.location.search || '')) forcar = true; } catch (e) {}

    function sintaxe(code) { try { new Function(code); return true; } catch (e) { return false; } }

    // Código das páginas (async/await, const, =>, `${}`, {...obj})
    var sintaxeOk = !forcar && sintaxe('"use strict";var f=async function(){await 0};let a=(x=1)=>`${x}`;const {b,...c}={...{d:1}};class K{}for(const q of [1]){}');
    // Firebase 10 precisa de navegador mais novo ainda (ES2019+)
    var fbModerno = sintaxeOk && sintaxe('async function* g(){} try{}catch{} var o={...{}};') &&
        typeof Object.fromEntries === 'function' && typeof globalThis !== 'undefined' && !!(W.Promise && Promise.prototype.finally);
    var apisOk = !forcar && !!(W.Promise && W.Map && W.Set && W.Symbol && W.WeakMap && Object.assign && Object.entries && Object.values &&
        Array.from && Array.prototype.find && Array.prototype.findIndex && Array.prototype.includes &&
        String.prototype.padStart && String.prototype.startsWith && String.prototype.includes);

    var base = '';
    var cs = D.currentScript;
    if (!cs) { var ss = D.getElementsByTagName('script'); cs = ss[ss.length - 1]; }
    if (cs && cs.src) base = cs.src.replace(/[^\/]*$/, '');

    W.__ES_MODERNO = sintaxeOk;

    // ---------- sem internet: guarda as páginas no aparelho (sw.js na raiz do site) ----------
    try {
        if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost') && base) {
            var raiz = base.replace(/js\/$/, '');
            W.addEventListener('load', function () { navigator.serviceWorker.register(raiz + 'sw.js', { scope: raiz })['catch'](function () {}); });
        }
    } catch (e) {}
    if (!apisOk || !sintaxeOk) D.write('<script src="' + base + 'core-js.min.js"><\/script>');
    if (!sintaxeOk) D.write('<script src="' + base + 'babel.min.js"><\/script>');

    // ---------- pequenos complementos de DOM que o core-js não traz ----------
    var EP = W.Element && Element.prototype;
    if (EP) {
        if (!EP.matches) EP.matches = EP.msMatchesSelector || EP.webkitMatchesSelector || EP.mozMatchesSelector;
        if (!EP.closest) EP.closest = function (s) { var el = this; while (el && el.nodeType === 1) { if (el.matches(s)) return el; el = el.parentElement || el.parentNode; } return null; };
        var addTo = function (proto) {
            if (!proto) return;
            if (!proto.remove) proto.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
            function frag(args) { var f = D.createDocumentFragment(); for (var i = 0; i < args.length; i++) { var n = args[i]; f.appendChild(n instanceof Node ? n : D.createTextNode(String(n))); } return f; }
            if (!proto.replaceWith) proto.replaceWith = function () { if (this.parentNode) this.parentNode.replaceChild(frag(arguments), this); };
            if (!proto.before) proto.before = function () { if (this.parentNode) this.parentNode.insertBefore(frag(arguments), this); };
            if (!proto.after) proto.after = function () { if (this.parentNode) this.parentNode.insertBefore(frag(arguments), this.nextSibling); };
            if (proto === EP) {
                if (!proto.append) proto.append = function () { this.appendChild(frag(arguments)); };
                if (!proto.prepend) proto.prepend = function () { this.insertBefore(frag(arguments), this.firstChild); };
            }
        };
        addTo(EP); addTo(W.CharacterData && CharacterData.prototype);
    }
    if (W.NodeList && !NodeList.prototype.forEach) NodeList.prototype.forEach = Array.prototype.forEach;

    // ---------- Banco de dados (Supabase) ----------
    // Itapitanga: banco Supabase (mesmo arquivo para TV antiga e navegador novo — é ES5)
    W.__fb = function () {
        if (W.__PLD_BANCO__) return;
        D.write('<script src="js/pld-config.js?v=1"><\/script><script src="js/pld-banco.js?v=1"><\/script>');
    };

    // ---------- Tailwind: o cdn.tailwindcss.com só roda em navegador novo; nas TVs antigas usa o CSS pronto ----------
    W.__twcss = function (href) {
        if (!forcar && sintaxe('var a={};a?.b??1')) return;
        D.write('<link rel="stylesheet" href="' + href + '">');
    };

    // ---------- código moderno da página -> versão para TV antiga ----------
    function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + '_' + s.length; }
    W.__es5 = function (id, flag) {
        if (W[flag]) return;                          // o código original já rodou neste navegador
        var el = D.getElementById(id);
        if (!el) return;
        var src = el.text || el.textContent || '';
        var chave = 'es5:' + id, h = hash(src), code = null;
        try { var c = JSON.parse(localStorage.getItem(chave) || 'null'); if (c && c.h === h) code = c.code; } catch (e) {}
        if (!code) {
            if (!W.Babel) { if (W.console) console.error('tv-compat: Babel não carregou'); return; }
            try {
                code = W.Babel.transform(src, { presets: [['env', { modules: false, targets: { chrome: '38' } }]], sourceType: 'script', compact: false, comments: false }).code;
            } catch (e) { if (W.console) console.error('tv-compat: erro ao converter ' + id, e); return; }
            try {
                for (var i = localStorage.length - 1; i >= 0; i--) { var k = localStorage.key(i); if (k && k.indexOf(chave) === 0) localStorage.removeItem(k); }
                localStorage.setItem(chave, JSON.stringify({ h: h, code: code }));
            } catch (e) {}
        }
        var s = D.createElement('script');
        s.text = code;
        (el.parentNode || D.body || D.documentElement).insertBefore(s, el.nextSibling);
    };
})();
