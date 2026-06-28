/**
 * 3D Book Viewer
 * ─────────────
 * Cover atlas : 3418 × 2048 px  →  back(0-1536) | spine(1536-1882) | front(1882-3418)
 * Accent colour : #FF5D00
 *
 * Controls
 * ────────
 * Mouse drag       : orbit / look around book
 * Scroll wheel     : zoom in / out
 * Arrow Left/Right : previous / next page spread
 * W / A / D        : yaw/pitch the book (W = tilt up, A = rotate left, D = rotate right)
 * P                : cycle camera preset positions (front → back → spine → top)
 * R                : reset camera & book rotation to default
 */

var CONFIG = {
  GS_API_URL   : 'https://script.google.com/macros/s/AKfycbwMew0JzgQMa3jU59xI9Ipzks1vpWw0zi_XXCOEBhQHnO9cw6qED00KD1Mu1LXhs6yXiQ/exec',
  PAGES_FOLDER : 'pages/',
  COVER_TEXTURE: 'cover.png',
  BOOK_WIDTH   : 1.536,
  BOOK_HEIGHT  : 2.048,
  BOOK_DEPTH   : 0.346,
  ACCENT       : 0xFF5D00,
  TURN_DURATION: 600,
};

(function () {
  'use strict';

  /* ── state ── */
  var pages      = [];
  var spread     = 0;
  var maxSpreads = 0;
  var animating  = false;

  /* ── Three.js ── */
  var renderer, scene, camera, book, coverMesh;
  var pageCanvases = {};

  /* ── camera presets  [x, y, z, lookAt] ── */
  var CAM_PRESETS = [
    { pos: new THREE.Vector3(0,    0,    4.6),  name: 'Front'  },
    { pos: new THREE.Vector3(0,    0,   -4.6),  name: 'Back'   },
    { pos: new THREE.Vector3(-4.6, 0,    0  ),  name: 'Spine'  },
    { pos: new THREE.Vector3(0,    4.6,  0  ),  name: 'Top'    },
  ];
  var camPresetIdx = 0;

  /* ── orbit state ── */
  var orbit = {
    dragging : false,
    lastX    : 0,
    lastY    : 0,
    // spherical coords for camera orbit
    theta    : 0,      // horizontal angle (radians)
    phi      : 0,      // vertical angle   (radians)
    radius   : 4.6,
    // limits
    phiMin   : -Math.PI / 2 + 0.05,
    phiMax   :  Math.PI / 2 - 0.05,
  };

  /* ── book manual rotation (W/A/D) ── */
  var bookRot = { x: -0.06, y: 0.35 };

  /* ── DOM ── */
  var loadingEl  = document.getElementById('loading');
  var fillEl     = document.getElementById('loading-bar-fill');
  var pageInfoEl = document.getElementById('page-info');
  var container  = document.getElementById('canvas-container');

  /* ════════════════════════════════════════════════════
     1.  GS API  — robust multi-shape parser
     ════════════════════════════════════════════════════
     Handles any of:
       { data: { pages: [1,2,3] } }
       { pages: [1,2,3] }
       [1,2,3]
       "1\n2\n3"  (plain text fallback)
  ════════════════════════════════════════════════════ */
  function extractNums(raw) {
    var data;
    try { data = JSON.parse(raw); } catch(e) { data = null; }

    var arr = null;

    if (Array.isArray(data)) {
      arr = data;
    } else if (data && typeof data === 'object') {
      // walk one level of nesting looking for the first array
      if (Array.isArray(data.pages)) {
        arr = data.pages;
      } else if (data.data && Array.isArray(data.data.pages)) {
        arr = data.data.pages;
      } else if (data.data && Array.isArray(data.data)) {
        arr = data.data;
      } else {
        // grab any array-valued key
        var keys = Object.keys(data);
        for (var i = 0; i < keys.length; i++) {
          if (Array.isArray(data[keys[i]])) { arr = data[keys[i]]; break; }
        }
        if (!arr) {
          // recurse one more level
          for (var i = 0; i < keys.length; i++) {
            var sub = data[keys[i]];
            if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
              var subKeys = Object.keys(sub);
              for (var j = 0; j < subKeys.length; j++) {
                if (Array.isArray(sub[subKeys[j]])) { arr = sub[subKeys[j]]; break; }
              }
              if (arr) break;
            }
          }
        }
      }
    }

    if (arr) {
      return arr.map(function(v){ return parseInt(v, 10); })
                .filter(function(n){ return !isNaN(n); });
    }

    // plain-text fallback
    return String(raw).split(/[\n,]+/)
      .map(function(v){ return parseInt(v.replace(/[^0-9]/g,''), 10); })
      .filter(function(n){ return !isNaN(n); });
  }

  function fetchPageList(callback) {
    var req = new XMLHttpRequest();
    req.open('GET', CONFIG.GS_API_URL, true);
    req.onload = function() {
      if (req.status >= 200 && req.status < 300) {
        var nums = extractNums(req.responseText);
        console.log('[GS] raw:', req.responseText.slice(0,200));
        console.log('[GS] parsed page nums:', nums);
        callback(null, nums);
      } else {
        callback(new Error('HTTP ' + req.status));
      }
    };
    req.onerror = function() { callback(new Error('Network error')); };
    req.send();
  }

  /* ════════════════════════════════════════════════════
     2.  FETCH PAGE TEXT FILES
  ════════════════════════════════════════════════════ */
  function fetchPageTexts(nums, onProgress, callback) {
    var results = {}, total = nums.length, done = 0;
    if (!total) { callback([]); return; }
    nums.forEach(function(n) {
      var req = new XMLHttpRequest();
      req.open('GET', CONFIG.PAGES_FOLDER + n + '.txt', true);
      req.onload = function() {
        results[n] = (req.status >= 200 && req.status < 300)
          ? req.responseText : '(page ' + n + ' not found)';
        if (++done === total) finish();
        else onProgress(done / total);
      };
      req.onerror = function() {
        results[n] = '(error loading page ' + n + ')';
        if (++done === total) finish();
        else onProgress(done / total);
      };
      req.send();
    });
    function finish() {
      onProgress(1);
      callback(nums.map(function(n){ return { num: n, text: results[n] }; }));
    }
  }

  /* ════════════════════════════════════════════════════
     3.  RENDER PAGE → CANVAS TEXTURE
  ════════════════════════════════════════════════════ */
  function makePageCanvas(pageObj) {
    var W = 768, H = 1024;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');

    ctx.fillStyle = '#f5f0e8';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#FF5D00';
    ctx.fillRect(48, 56, W - 96, 2);

    ctx.fillStyle = '#FF5D00';
    ctx.font = 'bold 18px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.fillText('— ' + pageObj.num + ' —', 48, 44);

    ctx.fillStyle = '#1a1a1a';
    ctx.font = '17px Georgia, serif';
    var lineH = 26, maxW = W - 96, y = 90, maxY = H - 60;
    var words = pageObj.text.split(/\s+/), line = '';
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, 48, y);
        line = words[i]; y += lineH;
        if (y > maxY) break;
      } else { line = test; }
    }
    if (y <= maxY && line) ctx.fillText(line, 48, y);

    ctx.fillStyle = '#FF5D00';
    ctx.fillRect(48, H - 52, W - 96, 1);
    return c;
  }

  /* ════════════════════════════════════════════════════
     4.  THREE.JS SCENE SETUP
  ════════════════════════════════════════════════════ */
  function initThree() {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.setClearColor(0x0d0d0d, 1);
    container.appendChild(renderer.domElement);

    scene  = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.01, 100);
    updateCameraFromOrbit();

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    var key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(3, 4, 5);
    key.castShadow = true;
    scene.add(key);

    var fill = new THREE.DirectionalLight(0xffeedd, 0.3);
    fill.position.set(-3, 1, 3);
    scene.add(fill);

    buildBook();
    animate();
  }

  /* ── camera from spherical coords ── */
  function updateCameraFromOrbit() {
    var r = orbit.radius;
    camera.position.set(
      r * Math.sin(orbit.theta) * Math.cos(orbit.phi),
      r * Math.sin(orbit.phi),
      r * Math.cos(orbit.theta) * Math.cos(orbit.phi)
    );
    camera.lookAt(0, 0, 0);
  }

  /* ── build book geometry ── */
  function buildBook() {
    var W = CONFIG.BOOK_WIDTH, H = CONFIG.BOOK_HEIGHT, D = CONFIG.BOOK_DEPTH;
    book = new THREE.Group();
    scene.add(book);

    var coverTex = new THREE.TextureLoader().load(CONFIG.COVER_TEXTURE, function() {
      renderer.render(scene, camera);
    });
    coverTex.minFilter = THREE.LinearFilter;

    var T = 3418;
    var uBack0=0, uBack1=1536/T, uSpine0=1536/T, uSpine1=1882/T, uFront0=1882/T, uFront1=1;

    var accentMat = new THREE.MeshLambertMaterial({ color: CONFIG.ACCENT });
    var coverMat  = new THREE.MeshLambertMaterial({ map: coverTex });

    // Front
    var frontGeo  = makeUVPanel(W, H, uFront0, 0, uFront1, 1);
    var frontMesh = new THREE.Mesh(frontGeo, coverMat);
    frontMesh.position.set(0, 0, D / 2);
    book.add(frontMesh);
    coverMesh = frontMesh;

    // Back
    var backMesh = new THREE.Mesh(makeUVPanel(W, H, uBack0, 0, uBack1, 1), coverMat);
    backMesh.rotation.y = Math.PI;
    backMesh.position.set(0, 0, -D / 2);
    book.add(backMesh);

    // Spine
    var spineMesh = new THREE.Mesh(makeUVPanel(D, H, uSpine0, 0, uSpine1, 1), coverMat);
    spineMesh.rotation.y = -Math.PI / 2;
    spineMesh.position.set(-W / 2, 0, 0);
    book.add(spineMesh);

    // Fore-edge (right)
    var foreMesh = new THREE.Mesh(new THREE.PlaneGeometry(D, H), accentMat);
    foreMesh.rotation.y = Math.PI / 2;
    foreMesh.position.set(W / 2, 0, 0);
    book.add(foreMesh);

    // Top / Bottom
    var topGeo = new THREE.PlaneGeometry(W, D);
    var topMesh = new THREE.Mesh(topGeo, accentMat);
    topMesh.rotation.x = -Math.PI / 2;
    topMesh.position.set(0, H / 2, 0);
    book.add(topMesh);

    var botMesh = new THREE.Mesh(topGeo.clone(), accentMat);
    botMesh.rotation.x = Math.PI / 2;
    botMesh.position.set(0, -H / 2, 0);
    book.add(botMesh);

    // Page stack sliver
    var stackMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.008, H - 0.01, D - 0.01),
      new THREE.MeshLambertMaterial({ color: 0xf0ebe0 })
    );
    stackMesh.position.set(W / 2 - 0.005, 0, 0);
    book.add(stackMesh);

    // Initial book rotation
    book.rotation.x = bookRot.x;
    book.rotation.y = bookRot.y;
  }

  function makeUVPanel(w, h, u0, v0, u1, v1) {
    var geo = new THREE.PlaneGeometry(w, h);
    var uv  = geo.attributes.uv;
    uv.setXY(0, u0, v1); uv.setXY(1, u1, v1);
    uv.setXY(2, u0, v0); uv.setXY(3, u1, v0);
    uv.needsUpdate = true;
    return geo;
  }

  /* ── render loop ── */
  function animate() {
    requestAnimationFrame(animate);
    // idle float only when not dragging / keying
    if (!orbit.dragging) {
      book.position.y = Math.sin(Date.now() * 0.0008) * 0.018;
    }
    renderer.render(scene, camera);
  }

  /* ════════════════════════════════════════════════════
     5.  PAGE SPREAD RENDERING
  ════════════════════════════════════════════════════ */
  function getSpreadPages() {
    if (spread === 0 || spread > maxSpreads) return null;
    var idx = 2 * (spread - 1);
    return { left: pages[idx] || null, right: pages[idx + 1] || null };
  }

  function renderSpread() {
    var sp = getSpreadPages();
    if (!sp) { applyCoverTexture(); return; }

    var W = 1536, H = 1024;
    var canvas = document.createElement('canvas');
    canvas.width = W * 2; canvas.height = H;
    var ctx = canvas.getContext('2d');

    ctx.fillStyle = '#e8e2d6';
    ctx.fillRect(0, 0, W * 2, H);

    var grad = ctx.createLinearGradient(W - 18, 0, W + 18, 0);
    grad.addColorStop(0,   'rgba(0,0,0,0.18)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.32)');
    grad.addColorStop(1,   'rgba(0,0,0,0.18)');
    ctx.fillStyle = grad;
    ctx.fillRect(W - 18, 0, 36, H);

    function drawPage(pageObj, ox) {
      if (!pageObj) return;
      if (!pageCanvases[pageObj.num]) pageCanvases[pageObj.num] = makePageCanvas(pageObj);
      ctx.drawImage(pageCanvases[pageObj.num], ox, 0, W, H);
    }
    drawPage(sp.left, 0);
    drawPage(sp.right, W);

    var tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    coverMesh.material = new THREE.MeshLambertMaterial({ map: tex });
    coverMesh.material.needsUpdate = true;
  }

  function applyCoverTexture() {
    var T = 3418, uF0 = 1882/T, uF1 = 1;
    var tex = new THREE.TextureLoader().load(CONFIG.COVER_TEXTURE);
    tex.minFilter = THREE.LinearFilter;
    coverMesh.geometry = makeUVPanel(CONFIG.BOOK_WIDTH, CONFIG.BOOK_HEIGHT, uF0, 0, uF1, 1);
    coverMesh.material = new THREE.MeshLambertMaterial({ map: tex });
    coverMesh.material.needsUpdate = true;
  }

  /* ════════════════════════════════════════════════════
     6.  PAGE TURN ANIMATION
  ════════════════════════════════════════════════════ */
  function turnTo(nextSpread, direction) {
    if (animating) return;
    if (nextSpread < 0 || nextSpread > maxSpreads + 1) return;
    animating = true;

    var baseY   = bookRot.y;
    var flipAmt = direction > 0 ? -0.55 : 0.55;
    var start   = null;
    var half    = CONFIG.TURN_DURATION / 2;
    var swapped = false;

    function step(ts) {
      if (!start) start = ts;
      var e = ts - start;
      var t;
      if (e < half) {
        t = ease(e / half);
        book.rotation.y = baseY + flipAmt * t;
      } else if (e < CONFIG.TURN_DURATION) {
        if (!swapped) {
          spread = nextSpread; renderSpread(); updateUI(); swapped = true;
        }
        t = ease((e - half) / half);
        book.rotation.y = (baseY + flipAmt) + (-flipAmt) * t;
      } else {
        book.rotation.y = bookRot.y = baseY;
        spread = nextSpread; animating = false;
        renderSpread(); updateUI();
        return;
      }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function ease(t) { return t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t; }
  function goNext() { if (spread < maxSpreads + 1) turnTo(spread + 1,  1); }
  function goPrev() { if (spread > 0)              turnTo(spread - 1, -1); }

  /* ════════════════════════════════════════════════════
     7.  CAMERA PRESET CYCLE (P)
  ════════════════════════════════════════════════════ */
  function cycleCameraPreset() {
    camPresetIdx = (camPresetIdx + 1) % CAM_PRESETS.length;
    var preset = CAM_PRESETS[camPresetIdx];
    // Convert cartesian preset to spherical
    var p = preset.pos;
    orbit.radius = p.length();
    orbit.phi    = Math.asin(p.y / orbit.radius);
    orbit.theta  = Math.atan2(p.x, p.z);
    updateCameraFromOrbit();
    showHint(preset.name + ' view');
  }

  /* ════════════════════════════════════════════════════
     8.  RESET (R)
  ════════════════════════════════════════════════════ */
  function resetView() {
    orbit.theta  = 0;
    orbit.phi    = 0;
    orbit.radius = 4.6;
    bookRot.x    = -0.06;
    bookRot.y    = 0.35;
    book.rotation.x = bookRot.x;
    book.rotation.y = bookRot.y;
    camPresetIdx = 0;
    updateCameraFromOrbit();
    showHint('Reset');
  }

  /* ════════════════════════════════════════════════════
     9.  HINT OVERLAY
  ════════════════════════════════════════════════════ */
  var hintTimeout;
  function showHint(text) {
    pageInfoEl.textContent = text;
    clearTimeout(hintTimeout);
    hintTimeout = setTimeout(updateUI, 1400);
  }

  /* ════════════════════════════════════════════════════
     10. UI
  ════════════════════════════════════════════════════ */
  function updateUI() {
    if (spread === 0) {
      pageInfoEl.textContent = 'Front Cover';
    } else if (spread > maxSpreads) {
      pageInfoEl.textContent = 'Back Cover';
    } else {
      var sp = getSpreadPages(), nums = [];
      if (sp.left)  nums.push(sp.left.num);
      if (sp.right) nums.push(sp.right.num);
      pageInfoEl.textContent = nums.length ? 'Page ' + nums.join(' – ') : '';
    }
  }

  function setProgress(pct) { fillEl.style.width = Math.round(pct * 100) + '%'; }

  function hideLoading() {
    loadingEl.style.transition = 'opacity 0.5s';
    loadingEl.style.opacity = '0';
    setTimeout(function() { loadingEl.style.display = 'none'; }, 500);
  }

  /* ════════════════════════════════════════════════════
     11. INPUT
  ════════════════════════════════════════════════════ */

  /* ── keyboard ── */
  var WAD_SPEED = 0.04;
  document.addEventListener('keydown', function(e) {
    switch (e.key) {
      case 'ArrowRight': goNext(); break;
      case 'ArrowLeft' : goPrev(); break;

      // W/A/D : yaw / pitch the book
      case 'w': case 'W':
        bookRot.x -= WAD_SPEED;
        book.rotation.x = bookRot.x;
        break;
      case 'a': case 'A':
        bookRot.y -= WAD_SPEED;
        book.rotation.y = bookRot.y;
        break;
      case 'd': case 'D':
        bookRot.y += WAD_SPEED;
        book.rotation.y = bookRot.y;
        break;

      case 'p': case 'P': cycleCameraPreset(); break;
      case 'r': case 'R': resetView();         break;
    }
  });

  /* ── mouse orbit ── */
  var canvas = null;
  function getCanvas() {
    if (!canvas) canvas = renderer.domElement;
    return canvas;
  }

  getCanvas || (function(){})(); // no-op, canvas lazily set

  document.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    orbit.dragging = true;
    orbit.lastX = e.clientX;
    orbit.lastY = e.clientY;
    document.body.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', function(e) {
    if (!orbit.dragging) return;
    var dx = e.clientX - orbit.lastX;
    var dy = e.clientY - orbit.lastY;
    orbit.lastX = e.clientX;
    orbit.lastY = e.clientY;

    var sensitivity = 0.005;
    orbit.theta -= dx * sensitivity;
    orbit.phi   += dy * sensitivity;
    orbit.phi    = Math.max(orbit.phiMin, Math.min(orbit.phiMax, orbit.phi));

    updateCameraFromOrbit();
  });

  document.addEventListener('mouseup',    function() { orbit.dragging = false; document.body.style.cursor = ''; });
  document.addEventListener('mouseleave', function() { orbit.dragging = false; document.body.style.cursor = ''; });

  /* ── scroll zoom ── */
  document.addEventListener('wheel', function(e) {
    e.preventDefault();
    orbit.radius += e.deltaY * 0.005;
    orbit.radius  = Math.max(1.5, Math.min(12, orbit.radius));
    updateCameraFromOrbit();
  }, { passive: false });

  /* ── touch orbit ── */
  var touch0 = null, touchDist0 = null;
  document.addEventListener('touchstart', function(e) {
    if (e.touches.length === 1) {
      touch0 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
      touchDist0 = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }, { passive: true });

  document.addEventListener('touchmove', function(e) {
    if (e.touches.length === 1 && touch0) {
      var dx = e.touches[0].clientX - touch0.x;
      var dy = e.touches[0].clientY - touch0.y;
      touch0 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      orbit.theta -= dx * 0.007;
      orbit.phi   += dy * 0.007;
      orbit.phi    = Math.max(orbit.phiMin, Math.min(orbit.phiMax, orbit.phi));
      updateCameraFromOrbit();
    } else if (e.touches.length === 2 && touchDist0 !== null) {
      var d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      orbit.radius *= touchDist0 / d;
      orbit.radius  = Math.max(1.5, Math.min(12, orbit.radius));
      touchDist0    = d;
      updateCameraFromOrbit();
    }
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', function() { touch0 = null; touchDist0 = null; });

  /* ── resize ── */
  window.addEventListener('resize', function() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* ════════════════════════════════════════════════════
     12. BOOT
  ════════════════════════════════════════════════════ */
  function boot() {
    initThree();
    setProgress(0.05);

    fetchPageList(function(err, nums) {
      if (err || !nums || !nums.length) {
        console.warn('[Book] Page list unavailable:', err);
        pages = []; maxSpreads = 0;
        updateUI(); hideLoading();
        return;
      }
      setProgress(0.15);
      fetchPageTexts(nums, function(frac) {
        setProgress(0.15 + frac * 0.8);
      }, function(loaded) {
        pages      = loaded;
        maxSpreads = Math.ceil(pages.length / 2);
        updateUI();
        hideLoading();
      });
    });
  }

  boot();

})();
