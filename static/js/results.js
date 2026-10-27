/* Results gallery + baseline comparison.
   Each scene is a single video file; extra panels (camera trajectory, other methods) are canvases that
   copy regions of that one video on every presented frame, so all panels stay frame-locked. */
(function () {
  'use strict';
  var DATA = window.SITE_DATA || {};
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasRVFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  function dpr() { return Math.min(window.devicePixelRatio || 1, 2); }
  function pad3(n) { return (n < 10 ? '00' : n < 100 ? '0' : '') + n; }

  /* ---------------------------------------------------------------- Mirror: video -> canvases */
  function Mirror(video) {
    var self = this, token = 0;
    this.v = video; this.views = [];
    function loop(tk) {
      return function () {
        if (tk !== token) return;
        self.draw();
        if (!video.paused && !video.ended) hasRVFC ? video.requestVideoFrameCallback(loop(tk)) : requestAnimationFrame(loop(tk));
      };
    }
    this.kick = function () { token++; var f = loop(token); hasRVFC ? video.requestVideoFrameCallback(f) : requestAnimationFrame(f); };
    ['loadeddata', 'seeked', 'pause'].forEach(function (e) { video.addEventListener(e, function () { self.draw(); }); });
    video.addEventListener('play', function () { self.kick(); });
    window.addEventListener('resize', function () { self.draw(); });
  }
  Mirror.prototype.draw = function () {
    var v = this.v;
    if (v.readyState < 2) return;
    for (var i = 0; i < this.views.length; i++) {
      var o = this.views[i], c = o.c;
      if (!c || c.offsetParent === null) continue;
      var d = dpr(), w = Math.max(1, Math.round(c.clientWidth * d)), h = Math.max(1, Math.round(c.clientHeight * d));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      var ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      try { ctx.drawImage(v, o.r[0], o.r[1], o.r[2], o.r[3], 0, 0, w, h); } catch (e) { /* not ready */ }
    }
  };

  /* ---------------------------------------------------------------- play / seek bar */
  var PLAY = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.8v10.4a.8.8 0 0 0 1.2.7l8.4-5.2a.8.8 0 0 0 0-1.4L4.2 1.1A.8.8 0 0 0 3 1.8z" fill="currentColor"/></svg>';
  var PAUSE = '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="2.5" y="1.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="8.5" y="1.5" width="3" height="11" rx="1" fill="currentColor"/></svg>';

  function Player(root, video, label) {
    var self = this;
    this.userPaused = reduceMotion; this.visible = false;
    var btn = root.querySelector('.ctl-play'), seek = root.querySelector('.ctl-seek'), time = root.querySelector('.ctl-time');
    var dragging = false;
    function icon() { var p = video.paused; btn.innerHTML = p ? PLAY : PAUSE; btn.setAttribute('aria-label', p ? 'Play' : 'Pause'); }
    function upd() {
      var d = video.duration;
      if (d && isFinite(d)) {
        if (!dragging) seek.value = Math.round(video.currentTime / d * 1000);
        seek.style.setProperty('--p', (video.currentTime / d * 100).toFixed(2) + '%');
      }
      time.textContent = label(video.currentTime, d);
    }
    function raf() { upd(); if (!video.paused) requestAnimationFrame(raf); }
    video.addEventListener('play', function () { icon(); requestAnimationFrame(raf); });
    video.addEventListener('pause', icon);
    video.addEventListener('timeupdate', upd);
    video.addEventListener('loadedmetadata', upd);
    btn.addEventListener('click', function () {
      if (video.paused) { self.userPaused = false; self.play(); } else { self.userPaused = true; video.pause(); }
    });
    seek.addEventListener('input', function () {
      dragging = true;
      var d = video.duration; if (d && isFinite(d)) video.currentTime = seek.value / 1000 * d;
      upd();
    });
    seek.addEventListener('change', function () { dragging = false; });
    this.play = function () {
      if (!video.getAttribute('src')) return;
      var p = video.play(); if (p && p.catch) p.catch(function () { icon(); });
    };
    this.sync = function () { if (self.visible && !self.userPaused) self.play(); else video.pause(); };
    icon();
  }

  function watch(el, player, onFirst) {
    var first = true;
    if (!('IntersectionObserver' in window)) { player.visible = true; if (onFirst) onFirst(); player.sync(); return; }
    new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting && first && onFirst) { first = false; onFirst(); }
      });
    }, { rootMargin: '400px 0px' }).observe(el);
    new IntersectionObserver(function (es) {
      es.forEach(function (e) { player.visible = e.isIntersecting && e.intersectionRatio > 0.2; player.sync(); });
    }, { threshold: [0, 0.2, 0.5] }).observe(el);
  }

  function thumbButton(src, label, onClick) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'thumb';
    b.innerHTML = '<img loading="lazy" alt="" src="' + src + '">';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.addEventListener('click', onClick);
    return b;
  }

  var DSNAME = { re10k: 'RealEstate10K', dl3dv: 'DL3DV' };

  /* ---------------------------------------------------------------- gallery */
  (function gallery() {
    var root = document.getElementById('gallery');
    var list = DATA.gallery;
    if (!root || !list) return;
    var SRC = root.getAttribute('data-src');
    var video = root.querySelector('.gv-video video'), poster = root.querySelector('.gv-poster');
    var inputImg = root.querySelector('.gv-input'), frameTag = root.querySelector('.gv-frame');
    var mDs = root.querySelector('.m-ds'), mFr = root.querySelector('.m-fr'), mId = root.querySelector('.m-id');
    var mirror = new Mirror(video);
    mirror.views.push({ c: root.querySelector('.gv-traj canvas'), r: [0, 336, 592, 336] });
    var cur = -1, buttons = [];
    /* the counter runs in original frames: RE10K 1..N (json) at 15/s, DL3DV 1..2N at 30/s */
    var player = new Player(root, video, function (t, d) {
      var s = list[cur]; if (!s) return '';
      var f = Math.min(s.count, Math.floor((t || 0) * s.rate + 1e-3) + 1);
      frameTag.textContent = 'frame ' + pad3(f) + ' / ' + s.count;
      return (t || 0).toFixed(1) + ' / ' + s.sec.toFixed(1) + ' s';
    });
    list.forEach(function (s, i) {
      var b = thumbButton(SRC + s.id + '_t.jpg', DSNAME[s.ds] + ' scene ' + s.id.split('_')[1], function () { select(i, true); });
      root.querySelector('.strip-group[data-ds="' + s.ds + '"] .thumbs').appendChild(b);
      buttons.push(b);
    });
    var loaded = false;
    function select(i, user) {
      cur = (i + list.length) % list.length;
      var s = list[cur];
      buttons.forEach(function (b, k) { b.setAttribute('aria-pressed', k === cur ? 'true' : 'false'); });
      poster.classList.remove('hide');
      poster.src = SRC + s.id + '.jpg';
      inputImg.src = SRC + s.id + '.jpg';
      mDs.textContent = DSNAME[s.ds];
      mFr.textContent = s.count + ' frames';
      mId.textContent = s.id.split('_')[1];
      frameTag.textContent = 'frame 001 / ' + s.count;
      if (loaded) { video.src = SRC + s.id + '.mp4'; video.load(); }
      if (user) { player.userPaused = false; }
      player.sync();
    }
    video.addEventListener('loadeddata', function () { poster.classList.add('hide'); mirror.draw(); });
    root.querySelector('.ctl-prev').addEventListener('click', function () { select(cur - 1, true); });
    root.querySelector('.ctl-next').addEventListener('click', function () { select(cur + 1, true); });
    var start = Math.max(0, list.findIndex(function (s) { return s.featured; }));
    select(start, false);
    watch(root, player, function () { if (!loaded) { loaded = true; video.src = SRC + list[cur].id + '.mp4'; video.load(); } player.sync(); });
    window.__gallery = { select: select, video: video };
    /* hero teaser tiles open the matching scene here */
    Array.prototype.forEach.call(document.querySelectorAll('.teaser-hit button'), function (b) {
      var id = b.getAttribute('data-id'), i = list.findIndex(function (s) { return s.id === id; });
      if (i < 0) return;
      b.setAttribute('aria-label', 'Open ' + DSNAME[list[i].ds] + ' scene ' + id.split('_')[1] + ' in the results gallery');
      b.addEventListener('click', function () {
        loaded = true;
        select(i, true);
        root.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      });
    });
  })();

  /* ---------------------------------------------------------------- comparison */
  /* tile index = position of each method in the comparison video's 5x2 grid */
  var TILE = { gt: 0, ours: 1, dfot: 2, lingbot: 3, worldwarp: 4, vmem: 5, trajcrafter: 6, cognvs: 7, vace: 8, viewcrafter: 9 };
  /* order of the baseline strip */
  var BASELINES = [
    { k: 'worldwarp', n: 'WorldWarp', g: 'vg' },
    { k: 'dfot', n: 'DFoT', g: 'vg' },
    { k: 'vmem', n: 'VMem', g: 'vg' },
    { k: 'lingbot', n: 'Lingbot-World', g: 'vg' },
    { k: 'trajcrafter', n: 'TrajCrafter', g: 'nvs' },
    { k: 'cognvs', n: 'CogNVS', g: 'nvs' },
    { k: 'vace', n: 'VACE', g: 'nvs' },
    { k: 'viewcrafter', n: 'ViewCrafter', g: 'nvs' }
  ];
  function rectOf(k) { var i = TILE[k]; return [(i % 5) * 336, Math.floor(i / 5) * 336, 336, 336]; }

  (function comparison() {
    var root = document.getElementById('cmp');
    var list = DATA.compare;
    if (!root || !list) return;
    var SRC = root.getAttribute('data-src'), TH = root.getAttribute('data-thumbs');
    var video = root.querySelector('.cmp-vbox video');
    var main = root.querySelector('.cmp-main');
    var mirror = new Mirror(video);
    var trajView = { c: root.querySelector('.cmp-traj canvas'), r: [0, 672, 592, 336] };
    var gtView = { c: root.querySelector('.cmp-tile[data-m="gt"] canvas'), r: rectOf('gt') };
    var selView = { c: root.querySelector('.cmp-tile[data-m="sel"] canvas'), r: rectOf('worldwarp') };
    mirror.views.push(trajView, gtView, selView);
    var selName = root.querySelector('.sel-name');
    var inImg = root.querySelector('.cmp-in img');
    var curScene = -1, curM = 'worldwarp', sceneBtns = [], miniBtns = [];
    /* the shown range is the first 200 frames; DL3DV numbering is doubled (1..400) */
    var player = new Player(root, video, function (t, d) {
      var s = list[curScene], total = s && s.ds === 'dl3dv' ? 400 : 200;
      var f = d && isFinite(d) ? Math.min(total, Math.floor(t / d * total) + 1) : 1;
      return 'frame ' + pad3(f) + ' / ' + total;
    });

    BASELINES.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'mini';
      b.innerHTML = '<canvas aria-hidden="true"></canvas><span>' + m.n + '</span>';
      b.addEventListener('click', function () { pick(m.k); });
      root.querySelector('.minis[data-g="' + m.g + '"]').appendChild(b);
      mirror.views.push({ c: b.querySelector('canvas'), r: rectOf(m.k) });
      miniBtns.push({ b: b, k: m.k });
    });
    function pick(k) {
      curM = k;
      selView.r = rectOf(k);
      selName.textContent = BASELINES.filter(function (m) { return m.k === k; })[0].n;
      miniBtns.forEach(function (o) { o.b.setAttribute('aria-pressed', o.k === k ? 'true' : 'false'); });
      mirror.draw();
    }
    list.forEach(function (s, i) {
      var b = thumbButton(TH + s.id + '_t.jpg', DSNAME[s.ds] + ' scene ' + s.id.split('_')[1], function () { scene(i, true); });
      root.querySelector('.cmp-scenes .strip-group[data-ds="' + s.ds + '"] .thumbs').appendChild(b);
      sceneBtns.push(b);
    });
    var loaded = false;
    function scene(i, user) {
      curScene = i;
      var s = list[i];
      sceneBtns.forEach(function (b, k) { b.setAttribute('aria-pressed', k === i ? 'true' : 'false'); });
      main.classList.toggle('nogt', !s.gt);
      root.querySelector('.ctl-time').textContent = 'frame 001 / ' + (s.ds === 'dl3dv' ? 400 : 200);
      inImg.src = TH + s.id + '.jpg';
      if (loaded) { video.src = SRC + s.id + '.mp4'; video.load(); }
      if (user) player.userPaused = false;
      player.sync();
    }
    video.addEventListener('loadeddata', function () { mirror.draw(); });
    pick('worldwarp');
    scene(0, false);
    watch(root, player, function () { loaded = true; video.src = SRC + list[curScene].id + '.mp4'; video.load(); player.sync(); });
    window.__cmp = { scene: scene, pick: pick, video: video };
  })();

  /* ---------------------------------------------------------------- quantitative table */
  (function table() {
    var el = document.getElementById('qt');
    var T = DATA.tables;
    if (!el || !T) return;
    var cols = [['PSNR', 1], ['SSIM', 1], ['LPIPS', -1], ['FID', -1], ['KID', -1], ['FVD', -1], ['mPSNR', 1]];
    function render(key) {
      var rows = T[key];
      var best = cols.map(function (c, j) {
        var v = rows.map(function (r) { return r.v[j]; });
        return c[1] > 0 ? Math.max.apply(null, v) : Math.min.apply(null, v);
      });
      var h = '<thead><tr><th scope="col">Method</th>' + cols.map(function (c) { return '<th scope="col">' + c[0] + (c[1] > 0 ? ' &uarr;' : ' &darr;') + '</th>'; }).join('') + '</tr></thead><tbody>';
      var grp = null;
      rows.forEach(function (r) {
        if (r.g !== grp) {
          grp = r.g;
          if (grp) h += '<tr class="grp"><td colspan="8">' + grp + '</td></tr>';
        }
        h += '<tr' + (r.ours ? ' class="ours"' : '') + '><td>' + r.n + '</td>' + r.v.map(function (x, j) {
          var s = r.s[j];
          return '<td>' + (x === best[j] ? '<b>' + s + '</b>' : s) + '</td>';
        }).join('') + '</tr>';
      });
      el.innerHTML = h + '</tbody>';
    }
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.quant .seg button'));
    tabs.forEach(function (b) {
      b.addEventListener('click', function () {
        tabs.forEach(function (o) { o.setAttribute('aria-selected', o === b ? 'true' : 'false'); });
        render(b.getAttribute('data-t'));
      });
    });
    render('re10k');
  })();
})();
