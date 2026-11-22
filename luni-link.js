/* Luni TV link: connect code + peer-to-peer transport (replaces the Python server).
   TV page   -> LuniLink.host()    answers /info, /poll, /state like luni_tv.py did
   Remote    -> LuniLink.client()  answers /send, /state by talking to the TV with the connect code */
(function () {
  'use strict';
  var ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789', RE = /^[a-z2-9]{8}$/, LS = 'luniCode';
  var ACTIONS = new Set(['vu', 'vd', 'mute', 'prev', 'next', 'pp', 'home', 'find', 'sets', 'last', 'info', 'help', 'back', 'ok', 'fav', 'sleep', 'pic', 'radio', 'radiomode', 'tvmode', 'gnext', 'gprev', 'rand']);
  var DIGITS = new Set('0123456789'.split('').concat(['Enter']));
  var BUTTONS = new Set(['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'START', 'SELECT']);
  var KEEP = ['mode', 'n', 'name', 'group', 'total', 'paused', 'vol', 'muted', 'fav', 'sleep', 'pic', 'radio'];
  var ID = function (c) { return 'luni-tv-' + c; };
  var code = null, listeners = [];

  function gen() {
    var a = new Uint32Array(8); crypto.getRandomValues(a);
    return Array.from(a, function (n) { return ALPHA[n % ALPHA.length]; }).join('');
  }
  function save(c) { try { localStorage.setItem(LS, c); } catch (e) {} }
  function load() { try { var c = localStorage.getItem(LS) || ''; return RE.test(c) ? c : null; } catch (e) { return null; } }
  function getCode() { if (!code) { code = load() || gen(); save(code); } return code; }
  function setCode(c) { code = c; save(c); listeners.forEach(function (f) { try { f(c); } catch (e) {} }); }
  function json(o, status) {
    return new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  }
  function urlOf(u) { return typeof u === 'string' ? u : (u && u.url) || ''; }

  /* ---------------- TV side ---------------- */
  function host() {
    if (window.__luniHost) return; window.__luniHost = true;
    var real = window.fetch.bind(window);
    var ev = [], nid = 0, waiters = [], state = {}, conns = new Set(), peer = null, tries = 0;

    function push(e) { nid++; ev.push([nid, e]); if (ev.length > 200) ev.shift(); var w = waiters; waiters = []; w.forEach(function (f) { f(); }); }
    function accept(d) {
      if (!d || typeof d !== 'object') return;
      if (d.n === 'hello') push({ n: 'hello' });
      else if (typeof d.t === 'string') push({ t: d.t.slice(0, 200) });
      else if (ACTIONS.has(d.a)) push({ a: d.a, rep: !!d.rep });
      else if (DIGITS.has(d.d)) push({ d: d.d });
      else if (BUTTONS.has(d.b)) push({ b: d.b, rep: !!d.rep });
    }
    function bc(m) { conns.forEach(function (c) { try { if (c.open) c.send(m); } catch (e) {} }); }

    function start() {
      if (typeof Peer === 'undefined') return;
      var p = peer = new Peer(ID(getCode()), { debug: 0 });
      p.on('open', function () { tries = 0; });
      p.on('connection', function (c) {
        c.on('open', function () { conns.add(c); try { c.send({ s: state }); } catch (e) {} });
        c.on('data', accept);
        c.on('close', function () { conns.delete(c); });
        c.on('error', function () { conns.delete(c); });
      });
      p.on('disconnected', function () { setTimeout(function () { try { if (!p.destroyed) p.reconnect(); } catch (e) {} }, 2000); });
      p.on('error', function (e) {
        if (e.type === 'unavailable-id') {
          try { p.destroy(); } catch (_) {}
          if (++tries <= 3) setTimeout(start, 2500);           // an old session may still be lingering
          else { tries = 0; setCode(gen()); start(); }          // taken by another open TV: pick a new code
        } else if (/network|server-error|socket/.test(e.type)) {
          try { p.destroy(); } catch (_) {}
          setTimeout(start, 5000);
        }
      });
    }

    function poll(path) {
      var after = parseInt(new URL(path, location.href).searchParams.get('after') || '-1', 10);
      var out = function () { return json({ id: nid, ev: ev.filter(function (e) { return e[0] > after; }).map(function (e) { return e[1]; }) }); };
      if (after < 0) return Promise.resolve(json({ id: nid, ev: [] }));
      if (ev.some(function (e) { return e[0] > after; })) return Promise.resolve(out());
      return new Promise(function (res) {
        var w = function () { clearTimeout(t); res(out()); };
        var t = setTimeout(function () { waiters = waiters.filter(function (x) { return x !== w; }); res(out()); }, 20000);
        waiters.push(w);
      });
    }

    window.fetch = function (u, o) {
      var s = urlOf(u);
      if (s === '/info') return Promise.resolve(json({ url: location.href, urls: [], qr: false, code: getCode() }));
      if (s.indexOf('/poll') === 0) return poll(s);
      if (s === '/state' && o && o.method === 'POST') {
        try {
          var d = JSON.parse(o.body || '{}'), n = {};
          KEEP.forEach(function (k) { if (k in d && /^(string|number|boolean)$/.test(typeof d[k])) n[k] = d[k]; });
          state = n; bc({ s: state });
        } catch (e) {}
        return Promise.resolve(json({ ok: true }));
      }
      return real(u, o);
    };
    start();
  }

  /* ---------------- phone side ---------------- */
  function client() {
    if (window.__luniClient) return; window.__luniClient = true;
    var real = window.fetch.bind(window);
    var peer = null, peerP = null, conn = null, pending = null, inflight = null, st = null, stT = 0, ever = false;

    function getPeer() {
      if (peerP) return peerP;
      peerP = new Promise(function (res, rej) {
        if (typeof Peer === 'undefined') { peerP = null; return rej(new Error('PeerJS missing')); }
        var p = new Peer({ debug: 0 });
        var t = setTimeout(function () { if (!peer) { peerP = null; try { p.destroy(); } catch (e) {} rej(new Error('timeout')); } }, 10000);
        p.on('open', function () { clearTimeout(t); peer = p; res(p); });
        p.on('error', function (e) {
          if (e.type === 'peer-unavailable' && pending && String(e.message).indexOf(pending.id) > -1) pending.fin('nopeer');
          else if (!peer) { clearTimeout(t); peerP = null; rej(e); }
        });
        p.on('disconnected', function () { try { p.reconnect(); } catch (e) {} });
      });
      return peerP;
    }
    function connectTo(k) {
      return function (p) {
        if (conn) { try { conn.close(); } catch (e) {} conn = null; }
        var c = p.connect(ID(k), { reliable: true }), o = { id: ID(k) };
        o.p = new Promise(function (res) {
          var t = setTimeout(function () { o.fin('timeout'); }, 9000);
          o.fin = function (r) { if (pending !== o) return; pending = null; clearTimeout(t); if (r !== 'ok') { try { c.close(); } catch (e) {} } res(r); };
          c.on('open', function () { conn = c; c.__k = k; ever = true; o.fin('ok'); });
          c.on('data', function (d) { if (d && d.s && typeof d.s === 'object') { st = d.s; stT = Date.now(); } });
          c.on('close', function () { if (conn === c) conn = null; });
          c.on('error', function () { o.fin('error'); });
        });
        pending = o; return o.p;
      };
    }
    function ensure(k) {
      if (!RE.test(k)) return Promise.resolve('bad');
      if (conn && conn.open && conn.__k === k) return Promise.resolve('ok');
      if (inflight && inflight.k === k) return inflight.p;
      var f = inflight = { k: k };
      f.p = getPeer().then(connectTo(k)).then(
        function (r) { if (inflight === f) inflight = null; return r; },
        function () { if (inflight === f) inflight = null; return 'offline'; });
      return f.p;
    }

    window.fetch = function (u, o) {
      var s = urlOf(u);
      if (s === '/send') {
        var d; try { d = JSON.parse(o.body); } catch (e) { return Promise.resolve(json({ ok: false }, 400)); }
        var k = String(d.k || '').trim().toLowerCase(); delete d.k;
        return ensure(k).then(function (r) {
          if (r === 'ok') { try { conn.send(d); } catch (e) { return json({ ok: false }, 503); } return json({ ok: true }); }
          return json({ ok: false }, r === 'bad' || r === 'nopeer' ? 403 : 503);
        });
      }
      if (s.indexOf('/state') === 0) {
        if (!ever || !st) return Promise.resolve(json({ ok: false }, 403));
        return Promise.resolve(json(Object.assign({}, st, { online: !!(conn && conn.open) && Date.now() - stT < 15000 })));
      }
      return real(u, o);
    };
  }

  window.LuniLink = {
    code: getCode,
    newCode: function () { setCode(gen()); return code; },
    onChange: function (f) { listeners.push(f); },
    valid: function (c) { return RE.test(String(c || '').trim().toLowerCase()); },
    host: host, client: client
  };
})();
