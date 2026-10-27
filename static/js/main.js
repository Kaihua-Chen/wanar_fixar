/* Page chrome: section menu (active section, mobile toggle), autoplay-on-screen, copy-to-clipboard. */
(function () {
  'use strict';
  var links = Array.prototype.slice.call(document.querySelectorAll('.sidenav a'));
  var secs = links.map(function (a) { return document.querySelector(a.getAttribute('href')); }).filter(Boolean);
  if ('IntersectionObserver' in window && secs.length) {
    var vis = {};
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { vis[e.target.id] = e.isIntersecting ? e.intersectionRatio : 0; });
      var best = null, bv = 0;
      secs.forEach(function (s) { if ((vis[s.id] || 0) > bv) { bv = vis[s.id]; best = s.id; } });
      links.forEach(function (a) { a.classList.toggle('active', !!best && a.getAttribute('href') === '#' + best); });
    }, { threshold: [0, 0.15, 0.4, 0.7], rootMargin: '0px 0px -35% 0px' });
    secs.forEach(function (s) { io.observe(s); });
  }

  /* section menu: a rail on wide screens, a floating button + card otherwise */
  var nav = document.getElementById('sidenav'), tog = document.getElementById('navtoggle');
  if (nav && tog) {
    var setOpen = function (o) { nav.classList.toggle('open', o); tog.setAttribute('aria-expanded', o ? 'true' : 'false'); };
    tog.addEventListener('click', function (e) { e.stopPropagation(); setOpen(!nav.classList.contains('open')); });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('click', function (e) { if (!nav.contains(e.target) && e.target !== tog) setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
  }

  /* simple looping videos: play only while on screen. Safari set to "Never Auto-Play" (or in Low Power Mode)
     rejects play() even for muted video, so blocked ones are started on the first click or key press. */
  var auto = document.querySelectorAll('video[data-autoplay]');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var blocked = [];
  function tryPlay(v) {
    var p = v.play();
    if (p && p.catch) p.catch(function () { if (blocked.indexOf(v) < 0) blocked.push(v); });
  }
  function unblock() {
    var b = blocked; blocked = [];
    /* playing inside the gesture unlocks each video; off-screen ones are paused again right away */
    b.forEach(function (v) {
      var p = v.play();
      if (p && p.then) p.then(function () { if (!v._onScreen) v.pause(); }, function () { });
    });
  }
  ['pointerdown', 'keydown', 'touchend'].forEach(function (t) { document.addEventListener(t, unblock, true); });
  if ('IntersectionObserver' in window) {
    var vio = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        var v = e.target;
        v._onScreen = e.isIntersecting;
        if (e.isIntersecting && !reduce) tryPlay(v);
        else v.pause();
      });
    }, { threshold: 0.15 });
    Array.prototype.forEach.call(auto, function (v) { if (reduce) v.removeAttribute('autoplay'); vio.observe(v); });
  }

  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var el = document.querySelector(btn.getAttribute('data-copy'));
      if (!el) return;
      var txt = el.textContent;
      function done(ok) { btn.textContent = ok ? 'Copied' : 'Select and copy'; setTimeout(function () { btn.textContent = 'Copy'; }, 1600); }
      function fallback() {
        var r = document.createRange(); r.selectNodeContents(el);
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        var ok = false; try { ok = document.execCommand('copy'); } catch (e) { }
        done(ok);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(function () { done(true); }, fallback);
      else fallback();
    });
  });
})();
