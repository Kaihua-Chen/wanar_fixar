/* Animated method pipeline in three stages: WanAR autoregressive rollouts (each one lifts its anchor frame,
   warps it into the next chunk of cameras and inpaints it) -> FixAR keyframe refinement -> InterpolatAR.
   Left: WebGL view of the anchor point clouds and the camera trajectory.
   Right: the frame each stage produces. Bottom: one cell per frame for each model.
   Everything is a pure function of one clock (T), so steps can be jumped to and replayed. */
(function () {
  'use strict';
  var D = window.METHOD_DATA;
  var root = document.getElementById('pipeline');
  if (!root || !D) return;

  var BASE = root.getAttribute('data-src') || 'static/method/';
  var NF = D.nframes, IW = D.W, IH = D.H;
  var fx = D.K[0][0], fy = D.K[1][1], cx = D.K[0][2], cy = D.K[1][2];
  var KEYS = D.keyframes;
  var isKey = new Array(NF + 2).fill(false);
  KEYS.forEach(function (k) { isKey[k] = true; });
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ANCHOR_Z = 0.24; /* depth of the anchor frustum's image plane (scene units) */

  /* ------------------------------------------------------------ helpers */
  function cl(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function seg(t, a, b) { return cl((t - a) / (b - a)); }
  function ez(x) { x = cl(x); return x * x * (3 - 2 * x); }
  /* the example is shown at every 2nd frame: cell f is frame 2f of the 230-frame video (cell 1 is frame 1) */
  function dnum(f) { return f <= 1.0001 ? 1 : Math.min(2 * NF, Math.round(2 * f)); }
  function pad(f) { var n = dnum(f); return (n < 10 ? '00' : n < 100 ? '0' : '') + n; }
  function cssColor(name) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000000';
    if (v[0] === '#' && v.length === 4) v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    var n = parseInt(v.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  /* camera pose for a fractional (1-based) frame index; MegaSAM c2w in OpenCV convention */
  function pose(f) {
    f = Math.max(1, Math.min(NF, f));
    var i0 = Math.floor(f) - 1, i1 = Math.min(NF - 1, i0 + 1), a = f - Math.floor(f);
    var A = D.c2w[i0], B = D.c2w[i1], M = [[], [], []];
    for (var r = 0; r < 3; r++) for (var c = 0; c < 4; c++) M[r][c] = A[r][c] * (1 - a) + B[r][c] * a;
    return M;
  }
  /* OpenCV camera coords -> GL world (y up, z backwards) */
  function c2world(M, x, y, z) {
    return [M[0][0] * x + M[0][1] * y + M[0][2] * z + M[0][3],
      -(M[1][0] * x + M[1][1] * y + M[1][2] * z + M[1][3]),
      -(M[2][0] * x + M[2][1] * y + M[2][2] * z + M[2][3])];
  }

  /* ------------------------------------------------------------ DOM */
  var q = function (s) { return root.querySelector(s); };
  var stepBtns = Array.prototype.slice.call(root.querySelectorAll('.pl-step'));
  var segFills = stepBtns.map(function (b) { return Array.prototype.slice.call(b.querySelectorAll('.bar b')); });
  var playBtn = q('.pl-play');
  var capK = q('.pl-cap .k'), capH = q('.pl-cap h3'), capP = q('.pl-cap p'), capBox = q('.pl-cap');
  var frame = q('.pl-frame');
  var imgBase = frame.querySelector('img.base'), imgTop = frame.querySelector('img.top');
  var wipeLine = frame.querySelector('.wipe-line');
  var ftag = frame.querySelector('.pl-ftag'), badge = frame.querySelector('.pl-badge');
  var wlL = frame.querySelector('.pl-wl.l'), wlR = frame.querySelector('.pl-wl.r');
  var hint = q('.pl-hint');

  var STILLS = ['input_001', 'warp_049', 'wanar_049', 'warp_097', 'wanar_097', 'warp_115', 'wanar_115', 'fixar_115'];
  var stillSrc = {};
  STILLS.forEach(function (k) { stillSrc[k] = BASE + k + '.jpg'; var im = new Image(); im.src = stillSrc[k]; });

  /* The warp clips and the final video are JPEG frame sequences stepped by the animation clock, not
     <video>s: Safari would not reliably play short hidden clips on cue. Frames load once the section is near. */
  var CLIPS = { r1: 49, r2: 49, r3: 19, fin: 115 }; /* frames per clip */
  var clipImg = document.createElement('img');
  clipImg.className = 'clip'; clipImg.alt = ''; clipImg.hidden = true;
  frame.insertBefore(clipImg, wipeLine);
  function clipSrc(k, i) { return BASE + 'frames/' + k + '/' + (i < 10 ? '00' : i < 100 ? '0' : '') + i + '.jpg'; }
  var clipFrames = null; /* keeps the preloaded images alive */
  function loadClips() {
    if (clipFrames) return;
    clipFrames = [];
    Object.keys(CLIPS).forEach(function (k) {
      for (var i = 1; i <= CLIPS[k]; i++) { var im = new Image(); im.src = clipSrc(k, i); clipFrames.push(im); }
    });
  }

  /* timeline */
  var rows = {};
  ['wanar', 'fixar', 'interp'].forEach(function (r) {
    var box = q('.tl-row[data-row="' + r + '"] .tl-cells');
    var cells = [null];
    for (var f = 1; f <= NF; f++) { var sp = document.createElement('span'); box.appendChild(sp); cells.push(sp); }
    rows[r] = { cells: cells, cls: new Array(NF + 1).fill('') };
  });
  var brackets = Array.prototype.slice.call(root.querySelectorAll('.tl-br > div'));
  var driftBar = q('.tl-drift');
  var driftLab = q('.drift-lab');
  var playhead = q('.tl-play');
  (function axis() {
    var ax = q('.tl-axis');
    [1, 49, 97, 115].forEach(function (f) {
      var s = document.createElement('span');
      s.textContent = dnum(f);
      s.style.left = ((f - 0.5) / NF * 100) + '%';
      ax.appendChild(s);
    });
  })();

  /* ------------------------------------------------------------ steps */
  /* segs: windows (stage-local seconds) of the segments in each stage's progress bar; WanAR has one per rollout */
  var INFO = [
    { k: 'Stage 1 · WanAR', h: 'Autoregressive rollouts', c: '--accent', segs: [[0, 7.0], [7.0, 10.7], [10.7, 14.4]],
      p: 'Each rollout lifts its anchor frame to 3D with depth aligned to the input cameras, warps it into the next chunk of cameras, and inpaints the chunk with WanAR. The last generated frame anchors the next rollout. Rollouts only see the immediate past, so errors accumulate (drift).' },
    { k: 'Stage 2 · FixAR', h: 'Refine keyframes with long-range context', c: '--fix',
      p: 'FixAR jointly refines 49 keyframes sampled sparsely across all rollouts. With this temporally subsampled, long-range context, it mitigates drift and cleans up accumulated artifacts.' },
    { k: 'Stage 3 · InterpolatAR', h: 'Interpolate to the full frame rate', c: '--interp',
      p: 'InterpolatAR fills in the frames between corrected keyframes. It only interpolates between generated frames, so it adds no new drift.' }
  ];

  function blank() {
    return {
      clouds: [{ a: 0, l: 0 }, { a: 0, l: 0 }, { a: 0, l: 0 }],
      anchors: [], vcam: null, trail: null, keys: 0,
      path: { a: 0, f0: 1, f1: 49 },
      panel: { mode: 'img', a: 'input_001' },
      tag: '', badge: null, wl: null,
      wan: new Array(NF + 1).fill(0), sel: 0, fixKey: 0, fixDone: 0, interpKey: 0, interpFill: 0,
      play: null, drift: 0, br: -1, view: 1
    };
  }

  /* Stage-local windows (seconds). Each rollout: new anchor -> lift to 3D -> warp (clip) -> inpaint (wipe).
     The lifts (reconstruct) keep their original pace; warping and inpainting are quicker. */
  var R1 = { lift: [0.7, 2.7], view: [0.5, 3.1], path: [2.5, 3.3], warp: [3.4, 6.0], wipe: [6.05, 6.75], fade: [6.6, 7.0] };
  var R2 = { start: 7.0, lift: [7.4, 8.7], warp: [8.7, 10.1], wipe: [10.1, 10.6] };
  var R3 = { start: 10.7, lift: [11.1, 12.1], warp: [12.1, 12.7], wipe: [12.7, 13.2] };
  var DRIFT = 13.2;

  var STEPS = [
    { dur: 14.4, fn: function (s, t) {
      var k, p, f;
      /* rollout 1: lift the input frame to 3D, warp it into the first chunk, inpaint with WanAR */
      s.clouds[0].a = ez(seg(t, 0, 0.4));
      s.clouds[0].l = ez(seg(t, R1.lift[0], R1.lift[1]));
      s.view = ez(seg(t, R1.view[0], R1.view[1]));
      s.anchors.push({ f: 1, a: ez(seg(t, 0, 0.3)) });
      s.path = { a: ez(seg(t, R1.path[0], R1.path[1])), f0: 1, f1: 49 };
      s.panel = { mode: 'img', a: 'input_001' };
      s.tag = 'Input frame · 001';
      s.wan[1] = 3; s.br = 0; s.play = 1;
      if (t >= R1.warp[0]) {
        p = seg(t, R1.warp[0], R1.warp[1]); f = 1 + 48 * p;
        s.vcam = { f: f, a: 1 }; s.trail = { f0: 2, f1: f, a: 1 };
        for (k = 2; k <= Math.floor(f + 1e-6); k++) s.wan[k] = 1;
        s.panel = t < R1.warp[1] ? { mode: 'clip', v: 'r1', i: f, base: 'input_001' } : { mode: 'img', a: 'warp_049' };
        s.tag = 'Warped view · frame ' + pad(f); s.play = f;
      }
      if (t >= R1.warp[1]) {
        var w1 = ez(seg(t, R1.wipe[0], R1.wipe[1]));
        s.panel = { mode: 'wipe', a: 'warp_049', b: 'wanar_049', p: w1 }; s.wl = ['WanAR', 'Warped'];
        for (k = 2; k <= 49; k++) s.wan[k] = ((k - 1.5) / 48 < w1) ? 2 : 1;
        var fade = 1 - ez(seg(t, R1.fade[0], R1.fade[1]));
        s.vcam.a = fade; s.trail.a = fade;
        s.tag = w1 < 1 ? 'Inpainting · frame 098' : 'WanAR output · frame 098'; s.play = 49;
      }
      /* rollout 2: the last generated frame is the new anchor */
      if (t >= R2.start) {
        var a1 = ez(seg(t, R2.start, R2.start + 0.4));
        s.clouds[0].a = 1 - 0.72 * a1;
        s.anchors.push({ f: 49, a: a1 });
        s.clouds[1].a = a1; s.clouds[1].l = ez(seg(t, R2.lift[0], R2.lift[1]));
        s.wan[49] = 3; s.br = 1; s.wl = null; s.vcam = null; s.trail = null;
        s.path = { a: 1, f0: 49, f1: 97 };
        s.panel = { mode: 'img', a: 'wanar_049' }; s.tag = 'New anchor · frame 098'; s.play = 49;
      }
      if (t >= R2.warp[0]) {
        p = seg(t, R2.warp[0], R2.warp[1]); f = 49 + 48 * p;
        s.vcam = { f: f, a: 1 }; s.trail = { f0: 50, f1: f, a: 1 };
        for (k = 50; k <= Math.floor(f + 1e-6); k++) s.wan[k] = 1;
        s.panel = t < R2.warp[1] ? { mode: 'clip', v: 'r2', i: f - 48, base: 'wanar_049' } : { mode: 'img', a: 'warp_097' };
        s.tag = 'Warped view · frame ' + pad(f); s.play = f;
      }
      if (t >= R2.wipe[0]) {
        var w2 = ez(seg(t, R2.wipe[0], R2.wipe[1]));
        s.panel = { mode: 'wipe', a: 'warp_097', b: 'wanar_097', p: w2 }; s.wl = ['WanAR', 'Warped'];
        for (k = 50; k <= 97; k++) s.wan[k] = ((k - 49.5) / 48 < w2) ? 2 : 1;
        s.vcam.a = 1 - w2; s.trail.a = 1 - w2;
        s.tag = w2 < 1 ? 'Inpainting · frame 194' : 'WanAR output · frame 194'; s.play = 97;
      }
      /* rollout 3 */
      if (t >= R3.start) {
        var a2 = ez(seg(t, R3.start, R3.start + 0.4));
        s.clouds[0].a = 0.28 - 0.1 * a2;
        s.clouds[1].a = 1 - 0.72 * a2;
        s.anchors.push({ f: 97, a: a2 });
        s.clouds[2].a = a2; s.clouds[2].l = ez(seg(t, R3.lift[0], R3.lift[1]));
        s.wan[97] = 3; s.br = 2; s.wl = null; s.vcam = null; s.trail = null;
        s.path = { a: 1, f0: 97, f1: 115 };
        s.panel = { mode: 'img', a: 'wanar_097' }; s.tag = 'New anchor · frame 194'; s.play = 97;
      }
      if (t >= R3.warp[0]) {
        p = seg(t, R3.warp[0], R3.warp[1]); f = 97 + 18 * p;
        s.vcam = { f: f, a: 1 }; s.trail = { f0: 98, f1: f, a: 1 };
        for (k = 98; k <= Math.floor(f + 1e-6); k++) s.wan[k] = 1;
        s.panel = t < R3.warp[1] ? { mode: 'clip', v: 'r3', i: f - 96, base: 'wanar_097' } : { mode: 'img', a: 'warp_115' };
        s.tag = 'Warped view · frame ' + pad(f); s.play = f;
      }
      if (t >= R3.wipe[0]) {
        var w3 = ez(seg(t, R3.wipe[0], R3.wipe[1]));
        s.panel = { mode: 'wipe', a: 'warp_115', b: 'wanar_115', p: w3 }; s.wl = ['WanAR', 'Warped'];
        for (k = 98; k <= 115; k++) s.wan[k] = ((k - 97.5) / 18 < w3) ? 2 : 1;
        s.vcam.a = 1 - w3; s.trail.a = 1 - w3;
        s.tag = w3 < 1 ? 'Inpainting · frame 230' : 'WanAR output · frame 230'; s.play = 115;
      }
      /* conditioned only on the immediate past, errors have accumulated */
      if (t >= DRIFT) {
        s.panel = { mode: 'img', a: 'wanar_115' }; s.wl = null;
        s.drift = ez(seg(t, DRIFT, DRIFT + 0.5));
        s.badge = s.drift > 0.15 ? 'drift' : null;
        s.tag = 'WanAR output · frame 230';
      }
    } },
    { dur: 5.4, fn: function (s, t) {
      var sel = seg(t, 0.15, 1.25);
      s.sel = sel; s.fixKey = sel;
      s.keys = ez(seg(t, 0, 0.8));
      s.clouds[0].a = 0.32; s.clouds[1].a = 0.32; s.clouds[2].a = 0.6;
      s.path = { a: 1, f0: 1, f1: 115 }; s.br = -1;
      s.vcam = null; s.trail = null;
      var p = ez(seg(t, 1.5, 3.4));
      s.fixDone = p;
      s.panel = { mode: 'wipe', a: 'wanar_115', b: 'fixar_115', p: p }; s.wl = ['FixAR', 'WanAR'];
      s.drift = 1 - p;
      s.badge = p < 0.5 ? 'drift' : 'fixed';
      s.tag = p < 1 ? (t < 1.5 ? 'Selecting 49 keyframes' : 'Refining keyframes') : 'FixAR output · keyframe 230';
      s.play = t < 1.25 ? 1 + 114 * sel : 115;
    } },
    { dur: 6.6, fn: function (s, t) {
      s.sel = 0;
      s.interpKey = ez(seg(t, 0, 0.5));
      var p = seg(t, 0.6, 5.8), f = 1 + 114 * p;
      s.interpFill = t >= 0.6 ? f : 0;
      s.keys = 0.55;
      s.clouds[0].a = 0.32; s.clouds[1].a = 0.32; s.clouds[2].a = 0.6;
      s.path = { a: 1, f0: 1, f1: 115 };
      s.panel = { mode: 'clip', v: 'fin', i: f, base: 'input_001' };
      s.vcam = { f: f, a: ez(seg(t, 0.3, 0.6)), interp: true };
      s.wl = null; s.drift = 0; s.badge = null;
      s.tag = 'Final video · frame ' + pad(f); s.play = f;
    } }
  ];
  var starts = [], TOTAL = 0;
  STEPS.forEach(function (st) { starts.push(TOTAL); TOTAL += st.dur; });
  var HOLD = 0.9, LOOP = TOTAL + HOLD;

  function stateAt(T) {
    var s = blank(), i = 0, t = Math.min(T, TOTAL - 1e-4);
    while (i < STEPS.length - 1 && t >= starts[i + 1]) i++;
    for (var k = 0; k < i; k++) STEPS[k].fn(s, STEPS[k].dur);
    STEPS[i].fn(s, t - starts[i]);
    s.step = i; s.lt = t - starts[i]; s.local = s.lt / STEPS[i].dur;
    return s;
  }

  /* ------------------------------------------------------------ WebGL */
  var canvas = q('.pl-3d canvas');
  var gl = null;
  try { gl = canvas.getContext('webgl', { antialias: true, alpha: false }) || canvas.getContext('experimental-webgl'); } catch (e) { gl = null; }
  var GLR = null;
  if (gl) GLR = initGL(gl); else { var ng = q('.pl-nogl'); if (ng) ng.hidden = false; }

  function initGL(gl) {
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    function prog(vs, fs) {
      var p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    }
    var ptProg = prog(
      'attribute vec3 aPos;attribute vec3 aStart;attribute vec3 aCol;attribute vec3 aMisc;' +
      'uniform mat4 uVP;uniform float uLift;uniform float uAlpha;uniform float uProj;' +
      'varying vec4 vCol;' +
      'void main(){float t=clamp((uLift-aMisc.z*0.38)/0.62,0.0,1.0);t=t*t*(3.0-2.0*t);' +
      'vec3 p=mix(aStart,aPos,t);vec4 c=uVP*vec4(p,1.0);gl_Position=c;' +
      'float sp=mix(aMisc.x,aMisc.y,t);gl_PointSize=clamp(1.3*sp*uProj/max(c.w,0.001),1.0,22.0);' +
      'vCol=vec4(aCol,uAlpha);}',
      'precision mediump float;varying vec4 vCol;void main(){gl_FragColor=vCol;}');
    var lnProg = prog(
      'attribute vec3 aA;attribute vec3 aB;attribute vec2 aSE;attribute vec4 aCol;attribute float aW;' +
      'uniform mat4 uVP;uniform vec2 uRes;varying vec4 vCol;' +
      'void main(){vec4 ca=uVP*vec4(aA,1.0);vec4 cb=uVP*vec4(aB,1.0);' +
      'vec2 sa=ca.xy/ca.w*uRes*0.5;vec2 sb=cb.xy/cb.w*uRes*0.5;vec2 d=sb-sa;' +
      'float L=length(d);d=L>1e-5?d/L:vec2(1.0,0.0);vec2 n=vec2(-d.y,d.x);' +
      'vec4 c=aSE.y<0.5?ca:cb;c.xy+=n*aSE.x*aW*0.5/(uRes*0.5)*c.w;gl_Position=c;vCol=aCol;}',
      'precision mediump float;varying vec4 vCol;void main(){gl_FragColor=vec4(vCol.rgb,vCol.a);}');

    var Z0 = ANCHOR_Z;
    var clouds = D.anchors.map(function (A) {
      var bin = atob(A.depth), n8 = bin.length, u8 = new Uint8Array(n8);
      for (var i = 0; i < n8; i++) u8[i] = bin.charCodeAt(i);
      var dq = new Uint16Array(u8.buffer);
      var cb = atob(A.rgb), rgb = new Uint8Array(cb.length);
      for (i = 0; i < cb.length; i++) rgb[i] = cb.charCodeAt(i);
      var n = 0; for (i = 0; i < dq.length; i++) if (dq[i]) n++;
      var M = pose(A.frame), S = D.stride, gw = A.w, gh = A.h;
      /* camera-space points on the depth grid (OpenCV), used for splat sizes */
      var dep = new Float32Array(gw * gh), X = new Float32Array(gw * gh * 3);
      for (var j = 0; j < gh; j++) for (var ii = 0; ii < gw; ii++) {
        var id = j * gw + ii, dd = dq[id] / 65535 * A.dmax;
        dep[id] = dq[id] ? dd : 0;
        X[id * 3] = ((ii * S + (S - 1) / 2) - cx) / fx * dd; X[id * 3 + 1] = ((j * S + (S - 1) / 2) - cy) / fy * dd; X[id * 3 + 2] = dd;
      }
      function nb(a, b) { /* distance to a neighbour on the same surface, else 0 */
        if (!dep[b] || Math.abs(dep[a] - dep[b]) > 0.07 * dep[a]) return 0;
        var dx = X[a * 3] - X[b * 3], dy = X[a * 3 + 1] - X[b * 3 + 1], dz = X[a * 3 + 2] - X[b * 3 + 2];
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      var buf = new Float32Array(n * 12), k = 0;
      for (j = 0; j < gh; j++) for (ii = 0; ii < gw; ii++) {
        var idx = j * gw + ii;
        if (!dep[idx]) continue;
        var d = dep[idx], lat = d * S / fx;
        var sp = Math.max(lat, Math.min(3.2 * lat, Math.max(ii + 1 < gw ? nb(idx, idx + 1) : 0, j + 1 < gh ? nb(idx, idx + gw) : 0, j > 0 ? nb(idx, idx - gw) : 0)));
        var xn = X[idx * 3] / d, yn = X[idx * 3 + 1] / d;
        var e = c2world(M, X[idx * 3], X[idx * 3 + 1], d), s0 = c2world(M, xn * Z0, yn * Z0, Z0), o = k * 12;
        buf[o] = e[0]; buf[o + 1] = e[1]; buf[o + 2] = e[2];
        buf[o + 3] = s0[0]; buf[o + 4] = s0[1]; buf[o + 5] = s0[2];
        buf[o + 6] = rgb[idx * 3] / 255; buf[o + 7] = rgb[idx * 3 + 1] / 255; buf[o + 8] = rgb[idx * 3 + 2] / 255;
        buf[o + 9] = Z0 * S / fx; buf[o + 10] = sp; buf[o + 11] = d / A.dmax;
        k++;
      }
      var vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
      return { vbo: vbo, n: n };
    });

    var P = {
      pt: { aPos: gl.getAttribLocation(ptProg, 'aPos'), aStart: gl.getAttribLocation(ptProg, 'aStart'), aCol: gl.getAttribLocation(ptProg, 'aCol'), aMisc: gl.getAttribLocation(ptProg, 'aMisc'),
        uVP: gl.getUniformLocation(ptProg, 'uVP'), uLift: gl.getUniformLocation(ptProg, 'uLift'), uAlpha: gl.getUniformLocation(ptProg, 'uAlpha'), uProj: gl.getUniformLocation(ptProg, 'uProj') },
      ln: { aA: gl.getAttribLocation(lnProg, 'aA'), aB: gl.getAttribLocation(lnProg, 'aB'), aSE: gl.getAttribLocation(lnProg, 'aSE'), aCol: gl.getAttribLocation(lnProg, 'aCol'), aW: gl.getAttribLocation(lnProg, 'aW'),
        uVP: gl.getUniformLocation(lnProg, 'uVP'), uRes: gl.getUniformLocation(lnProg, 'uRes') }
    };
    var lineVbo = gl.createBuffer();
    return { ptProg: ptProg, lnProg: lnProg, clouds: clouds, P: P, lineVbo: lineVbo, Z0: Z0 };
  }

  /* matrices (column-major) */
  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function lookAt(e, c, up) {
    var zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2], zl = Math.hypot(zx, zy, zz); zx /= zl; zy /= zl; zz /= zl;
    var xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx, xl = Math.hypot(xx, xy, xz); xx /= xl; xy /= xl; xz /= xl;
    var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1];
  }
  function mul(a, b) {
    var o = new Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  }

  var COL = {};
  function readColors() {
    COL = { accent: cssColor('--accent-hi'), anchor: cssColor('--anchor-hi'), fix: cssColor('--fix-hi'), interp: cssColor('--interp-hi'), ink3: cssColor('--path-hi'), bg: [0.086, 0.094, 0.114] };
    var bg = getComputedStyle(q('.pl-3d')).backgroundColor.match(/[\d.]+/g);
    if (bg && bg.length >= 3) COL.bg = [bg[0] / 255, bg[1] / 255, bg[2] / 255];
  }
  readColors();

  /* orbit camera around the scene */
  var orbit = { yaw: -0.40, pitch: 0.34, dist: 2.75, t: [0.12, 0.02, -1.25], fov: 0.74 };
  var autoAmp = reduceMotion ? 0 : 1, userYaw = 0, userPitch = 0, clock = 0;

  var L = [];
  function line(a, b, col, alpha, w) { L.push(a, b, col, alpha, w); }
  function frustum(f, z, col, alpha, w) {
    if (alpha <= 0.01) return;
    var M = pose(f), C = c2world(M, 0, 0, 0);
    var x0 = -cx / fx * z, x1 = (IW - cx) / fx * z, y0 = -cy / fy * z, y1 = (IH - cy) / fy * z;
    var cs = [c2world(M, x0, y0, z), c2world(M, x1, y0, z), c2world(M, x1, y1, z), c2world(M, x0, y1, z)];
    for (var i = 0; i < 4; i++) { line(C, cs[i], col, alpha, w); line(cs[i], cs[(i + 1) % 4], col, alpha, w); }
    /* small notch above the top edge marks "up" */
    var xm = (x0 + x1) / 2, hw = (x1 - x0) * 0.09;
    line(c2world(M, xm - hw, y0, z), c2world(M, xm, y0 - (y1 - y0) * 0.2, z), col, alpha, w);
    line(c2world(M, xm, y0 - (y1 - y0) * 0.2, z), c2world(M, xm + hw, y0, z), col, alpha, w);
  }

  function drawGL(s) {
    var g = gl, R = GLR;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cw = Math.max(1, Math.round(canvas.clientWidth * dpr)), ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    g.viewport(0, 0, cw, ch);
    g.clearColor(COL.bg[0], COL.bg[1], COL.bg[2], 1);
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);

    var aspect = cw / ch, vw = s.view;
    var dist = (0.95 + (orbit.dist - 0.95) * vw) * (aspect < 1.25 ? 1.18 : 1);
    var yaw = orbit.yaw + userYaw + autoAmp * 0.2 * Math.sin(clock * 0.32) * vw;
    var pitch = Math.max(0.05, Math.min(1.25, orbit.pitch + userPitch + autoAmp * 0.04 * Math.sin(clock * 0.21)));
    var cp = Math.cos(pitch), t = [orbit.t[0] * vw, orbit.t[1] * vw, -0.18 + (orbit.t[2] + 0.18) * vw];
    var eye = [t[0] + dist * Math.sin(yaw) * cp, t[1] + dist * Math.sin(pitch), t[2] + dist * Math.cos(yaw) * cp];
    var VP = mul(perspective(orbit.fov, aspect, 0.03, 40), lookAt(eye, t, [0, 1, 0]));
    var proj = ch / (2 * Math.tan(orbit.fov / 2));

    /* point clouds: opaque first, then translucent without depth writes */
    g.useProgram(R.ptProg);
    g.uniformMatrix4fv(R.P.pt.uVP, false, VP);
    g.uniform1f(R.P.pt.uProj, proj);
    g.enable(g.DEPTH_TEST);
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA);
    var order = [0, 1, 2].filter(function (i) { return s.clouds[i].a > 0.01; })
      .sort(function (a, b) { return (s.clouds[b].a >= 0.99) - (s.clouds[a].a >= 0.99); });
    var pa = R.P.pt;
    [pa.aPos, pa.aStart, pa.aCol, pa.aMisc].forEach(function (l) { g.enableVertexAttribArray(l); });
    order.forEach(function (i) {
      var c = R.clouds[i], st = s.clouds[i];
      g.depthMask(st.a >= 0.99);
      g.bindBuffer(g.ARRAY_BUFFER, c.vbo);
      g.vertexAttribPointer(pa.aPos, 3, g.FLOAT, false, 48, 0);
      g.vertexAttribPointer(pa.aStart, 3, g.FLOAT, false, 48, 12);
      g.vertexAttribPointer(pa.aCol, 3, g.FLOAT, false, 48, 24);
      g.vertexAttribPointer(pa.aMisc, 3, g.FLOAT, false, 48, 36);
      g.uniform1f(pa.uLift, st.l);
      g.uniform1f(pa.uAlpha, st.a);
      g.drawArrays(g.POINTS, 0, c.n);
    });
    [pa.aPos, pa.aStart, pa.aCol, pa.aMisc].forEach(function (l) { g.disableVertexAttribArray(l); });
    g.depthMask(true);

    /* lines: trajectory + frustums, drawn on top */
    L = [];
    var acc = COL.accent, anc = COL.anchor, ink = COL.ink3;
    if (s.path.a > 0.01) {
      for (var f = 1; f < NF; f++) {
        var on = f >= s.path.f0 && f + 1 <= s.path.f1;
        line(c2world(pose(f), 0, 0, 0), c2world(pose(f + 1), 0, 0, 0), on ? acc : ink, s.path.a * (on ? 0.95 : 0.45), on ? 2.4 : 1.6);
      }
    }
    if (s.keys > 0.01) KEYS.forEach(function (k) { frustum(k, 0.05, COL.fix, s.keys * 0.95, 1.1); });
    if (s.trail && s.trail.a > 0.01) {
      for (var tf = s.trail.f0; tf <= s.trail.f1; tf += 3) frustum(tf, 0.11, acc, s.trail.a * 0.38, 1);
    }
    s.anchors.forEach(function (a) { frustum(a.f, R.Z0, anc, a.a, 2.2); });
    if (s.vcam && s.vcam.a > 0.01) frustum(s.vcam.f, 0.16, s.vcam.interp ? COL.interp : acc, s.vcam.a, 2.6);

    var nseg = L.length / 5;
    if (nseg) {
      var arr = new Float32Array(nseg * 6 * 13), o = 0;
      for (var si = 0; si < nseg; si++) {
        var A = L[si * 5], B = L[si * 5 + 1], C = L[si * 5 + 2], al = L[si * 5 + 3], w = L[si * 5 + 4] * dpr;
        var corners = [[-1, 0], [1, 0], [-1, 1], [-1, 1], [1, 0], [1, 1]];
        for (var vi = 0; vi < 6; vi++) {
          arr[o++] = A[0]; arr[o++] = A[1]; arr[o++] = A[2];
          arr[o++] = B[0]; arr[o++] = B[1]; arr[o++] = B[2];
          arr[o++] = corners[vi][0]; arr[o++] = corners[vi][1];
          arr[o++] = C[0]; arr[o++] = C[1]; arr[o++] = C[2]; arr[o++] = al;
          arr[o++] = w;
        }
      }
      g.useProgram(R.lnProg);
      g.disable(g.DEPTH_TEST);
      g.uniformMatrix4fv(R.P.ln.uVP, false, VP);
      g.uniform2f(R.P.ln.uRes, cw, ch);
      g.bindBuffer(g.ARRAY_BUFFER, R.lineVbo);
      g.bufferData(g.ARRAY_BUFFER, arr, g.DYNAMIC_DRAW);
      var pl = R.P.ln;
      [pl.aA, pl.aB, pl.aSE, pl.aCol, pl.aW].forEach(function (l) { g.enableVertexAttribArray(l); });
      g.vertexAttribPointer(pl.aA, 3, g.FLOAT, false, 52, 0);
      g.vertexAttribPointer(pl.aB, 3, g.FLOAT, false, 52, 12);
      g.vertexAttribPointer(pl.aSE, 2, g.FLOAT, false, 52, 24);
      g.vertexAttribPointer(pl.aCol, 4, g.FLOAT, false, 52, 32);
      g.vertexAttribPointer(pl.aW, 1, g.FLOAT, false, 52, 48);
      g.drawArrays(g.TRIANGLES, 0, nseg * 6);
      [pl.aA, pl.aB, pl.aSE, pl.aCol, pl.aW].forEach(function (l) { g.disableVertexAttribArray(l); });
    }
  }

  /* drag to orbit */
  (function () {
    var box = q('.pl-3d'), drag = null;
    box.addEventListener('pointerdown', function (e) {
      drag = { x: e.clientX, y: e.clientY, yaw: userYaw, pitch: userPitch, id: e.pointerId };
      autoAmp = 0;
      if (hint) hint.style.opacity = '0';
    });
    window.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      userYaw = drag.yaw - (e.clientX - drag.x) * 0.006;
      userPitch = drag.pitch + (e.clientY - drag.y) * (e.pointerType === 'touch' ? 0 : 0.004);
      kick();
    });
    function up() { drag = null; }
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  })();

  /* ------------------------------------------------------------ apply state to the DOM */
  var cache = {};
  function setText(el, key, v) { if (cache[key] !== v) { cache[key] = v; el.textContent = v; } }
  function setSrc(img, key, v) { if (cache[key] !== v) { cache[key] = v; img.src = stillSrc[v]; } }

  function applyPanel(s, running) {
    var P = s.panel;
    if (P.mode === 'img') {
      setSrc(imgBase, 'base', P.a);
      imgTop.style.clipPath = 'inset(0 100% 0 0)';
      wipeLine.style.opacity = '0';
    } else if (P.mode === 'wipe') {
      setSrc(imgBase, 'base', P.a); setSrc(imgTop, 'top', P.b);
      var pc = (P.p * 100).toFixed(2);
      imgTop.style.clipPath = 'inset(0 ' + (100 - P.p * 100).toFixed(2) + '% 0 0)';
      wipeLine.style.left = pc + '%';
      wipeLine.style.opacity = P.p > 0.001 && P.p < 0.999 ? '1' : '0';
    } else if (P.mode === 'clip') {
      /* the still underneath shows the clip's first frame until its frames have loaded */
      setSrc(imgBase, 'base', P.base);
      imgTop.style.clipPath = 'inset(0 100% 0 0)';
      wipeLine.style.opacity = '0';
      loadClips();
      var src = clipSrc(P.v, Math.max(1, Math.min(CLIPS[P.v], Math.round(P.i))));
      if (cache.clip !== src) { cache.clip = src; clipImg.src = src; }
    }
    if (clipImg.hidden !== (P.mode !== 'clip')) clipImg.hidden = P.mode !== 'clip';
    var wl = s.wl;
    wlL.style.opacity = wl && P.mode === 'wipe' ? '1' : '0';
    wlR.style.opacity = wl && P.mode === 'wipe' ? '1' : '0';
    if (wl) { setText(wlL, 'wlL', wl[0]); setText(wlR, 'wlR', wl[1]); }
  }

  function setCell(row, f, c) { var R = rows[row]; if (R.cls[f] !== c) { R.cls[f] = c; R.cells[f].className = c; } }

  function apply(s, running) {
    /* steps */
    if (cache.step !== s.step) {
      cache.step = s.step;
      stepBtns.forEach(function (b, i) {
        b.classList.toggle('active', i === s.step);
        b.classList.toggle('done', i < s.step);
        b.setAttribute('aria-current', i === s.step ? 'step' : 'false');
      });
      var I = INFO[s.step];
      capK.textContent = I.k; capH.textContent = I.h; capP.textContent = I.p;
      capBox.style.setProperty('--c', 'var(' + I.c + ')');
    }
    stepBtns.forEach(function (b, i) {
      var segs = INFO[i].segs || [[0, STEPS[i].dur]];
      segFills[i].forEach(function (el, j) {
        var v = i === s.step ? seg(s.lt, segs[j][0], segs[j][1]) : (i < s.step ? 1 : 0);
        var key = 'bar' + i + '_' + j, str = v.toFixed(3);
        if (cache[key] !== str) { cache[key] = str; el.style.transform = 'scaleX(' + str + ')'; }
      });
    });

    applyPanel(s, running);
    setText(ftag, 'tag', s.tag);
    var bcls = 'pl-badge' + (s.badge ? ' on ' + s.badge : '');
    if (cache.badge !== bcls) { cache.badge = bcls; badge.className = bcls; if (s.badge) badge.textContent = s.badge; }

    /* timeline rows */
    for (var f = 1; f <= NF; f++) {
      var w = s.wan[f];
      var c = w === 3 ? 'anchor' : w === 2 ? 'gen' : w === 1 ? 'warp' : '';
      if (isKey[f] && s.sel > 0 && (f - 1) / (NF - 1) <= s.sel) c += ' sel';
      setCell('wanar', f, c);
      var fc = '';
      if (isKey[f]) {
        var x = (f - 1) / (NF - 1);
        fc = s.fixDone > 0 && x <= s.fixDone ? 'fix' : (s.fixKey > 0 && x <= s.fixKey ? 'key' : 'kf');
      }
      setCell('fixar', f, fc);
      var ic = '';
      if (isKey[f] && s.interpKey > 0 && (f - 1) / (NF - 1) <= s.interpKey * 1.0001) ic = 'fixkey';
      else if (s.interpFill > 0 && f <= s.interpFill + 1e-6) ic = 'interp';
      setCell('interp', f, ic);
    }
    brackets.forEach(function (b, i) { b.classList.toggle('on', i === s.br); });
    var dstr = s.drift.toFixed(2);
    if (cache.drift !== dstr) { cache.drift = dstr; driftBar.style.opacity = dstr; if (driftLab) driftLab.style.opacity = dstr; }
    if (s.play != null) {
      var left = ((s.play - 0.5) / NF * 100).toFixed(3) + '%';
      if (cache.play !== left) { cache.play = left; playhead.style.left = left; }
      if (cache.playOn !== 1) { cache.playOn = 1; playhead.style.opacity = '1'; }
    } else if (cache.playOn !== 0) { cache.playOn = 0; playhead.style.opacity = '0'; }
  }

  /* ------------------------------------------------------------ clock + loop */
  var T = 0, playing = !reduceMotion, visible = false, raf = 0, last = 0, userPaused = reduceMotion;
  if (reduceMotion) T = starts[2] - 0.001; /* static view: after FixAR */

  function render() {
    var s = stateAt(T);
    apply(s, playing && visible);
    if (GLR) drawGL(s);
  }
  function tick(now) {
    raf = 0;
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    if (visible) {
      clock += dt;
      if (playing) { T += dt; if (T >= LOOP) { T = 0; cache = {}; } }
      render();
      raf = requestAnimationFrame(tick);
    }
  }
  function kick() { if (!raf && visible) { last = 0; raf = requestAnimationFrame(tick); } }
  function setPlaying(p) {
    playing = p;
    playBtn.setAttribute('aria-label', p ? 'Pause animation' : 'Play animation');
    playBtn.innerHTML = p
      ? '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="2.5" y="1.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="8.5" y="1.5" width="3" height="11" rx="1" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.8v10.4a.8.8 0 0 0 1.2.7l8.4-5.2a.8.8 0 0 0 0-1.4L4.2 1.1A.8.8 0 0 0 3 1.8z" fill="currentColor"/></svg>';
    render();
    kick();
  }
  playBtn.addEventListener('click', function () {
    if (!playing && T >= TOTAL) T = 0;
    userPaused = playing;
    setPlaying(!playing);
  });
  stepBtns.forEach(function (b, i) {
    b.addEventListener('click', function () {
      T = starts[i] + 0.001;
      cache = {};
      if (userPaused) { T = starts[i] + STEPS[i].dur - 0.001; render(); kick(); }
      else setPlaying(true);
    });
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        visible = e.isIntersecting && e.intersectionRatio > 0.12;
        if (visible) kick();
      });
    }, { threshold: [0, 0.12, 0.3] }).observe(root);
    new IntersectionObserver(function (es, o) {
      if (es.some(function (e) { return e.isIntersecting; })) { loadClips(); o.disconnect(); }
    }, { rootMargin: '600px 0px' }).observe(root);
  } else { visible = true; loadClips(); }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { last = 0; kick(); }
  });
  window.addEventListener('resize', function () { render(); });

  setPlaying(playing);
  render();
  /* testing hook: window.__pipeline.seek(t) */
  window.__pipeline = { seek: function (t) { T = t; cache = {}; render(); }, state: function () { return { T: T }; }, total: TOTAL, starts: starts, pause: function () { userPaused = true; setPlaying(false); } };
})();
