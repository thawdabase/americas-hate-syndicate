/**
 * 3D Book Viewer
 * ─────────────
 * - Texture atlas: 3418 × 2048 px  (back | spine | front)
 *   back  = 0    … 1536 px  (1536 wide)
 *   spine = 1536 … 1882 px  (346 wide)
 *   front = 1882 … 3418 px  (1536 wide)
 * - Accent / bare-board colour: #FF5D00
 * - Pages fetched from Google Apps Script Web App
 * - Navigation: ← → arrow keys OR click left / right 50 % of screen
 */

/* ═══════════════════════════════════════════════════════════════════
   CONFIGURATION
   ═══════════════════════════════════════════════════════════════════ */
var CONFIG = {
  // Google Apps Script Web App URL – returns JSON with page numbers.
  // Expected response: { "pages": [1, 2, 3, ...] }
  GS_API_URL: 'https://script.google.com/macros/s/AKfycbwMew0JzgQMa3jU59xI9Ipzks1vpWw0zi_XXCOEBhQHnO9cw6qED00KD1Mu1LXhs6yXiQ/exec',

  // Folder (relative or absolute URL) that contains 1.txt, 2.txt, etc.
  PAGES_FOLDER: 'pages/',

  // Cover texture (the 3418 × 2048 atlas).
  COVER_TEXTURE: 'cover.png',

  // Book physical proportions (Three.js units)
  BOOK_WIDTH:  1.536,   // front/back panel width (1536 / 1000)
  BOOK_HEIGHT: 2.048,   // height                 (2048 / 1000)
  BOOK_DEPTH:  0.346,   // spine thickness        (346  / 1000)

  // Accent colour for edges / page stack
  ACCENT: 0xFF5D00,

  // Page turn animation duration (ms)
  TURN_DURATION: 600,
};
/* ═══════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── state ── */
  var pages       = [];   // array of {num, text} in reading order
  var spread      = 0;    // 0 = cover, 1 = spread 1 (pages 1-2), 2 = spread 2, …
  var maxSpreads  = 0;
  var animating   = false;

  /* ── Three.js globals ── */
  var renderer, scene, camera, book, coverMesh;
  var pageCanvases = {};  // num → HTMLCanvasElement (cached page textures)

  /* ── DOM ── */
  var loadingEl  = document.getElementById('loading');
  var fillEl     = document.getElementById('loading-bar-fill');
  var pageInfoEl = document.getElementById('page-info');
  var container  = document.getElementById('canvas-container');

  /* ══════════════════════════════════════════════════════
     1.  GOOGLE APPS SCRIPT  →  page list
     ══════════════════════════════════════════════════════
     Web App returns JSON: { "pages": [1, 2, 3, ...] }
     or a plain array:    [1, 2, 3, ...]
     Sheet: A1 = "pages" header, A2… = numbers.
     ══════════════════════════════════════════════════════ */
  function fetchPageList(callback) {
    var url = CONFIG.GS_API_URL;
    var req = new XMLHttpRequest();
    req.open('GET', url, true);
    req.onload = function () {
      if (req.status >= 200 && req.status < 300) {
        try {
          var data = JSON.parse(req.responseText);
          var nums;
          if (Array.isArray(data)) {
            nums = data.map(function (v) { return parseInt(v, 10); })
                       .filter(function (n) { return !isNaN(n); });
          } else if (data && Array.isArray(data.pages)) {
            nums = data.pages.map(function (v) { return parseInt(v, 10); })
                             .filter(function (n) { return !isNaN(n); });
          } else {
            // Fallback: plain text, newline or comma separated
            nums = String(req.responseText)
              .split(/[\n,]+/)
              .map(function (v) { return parseInt(v.replace(/"/g, '').trim(), 10); })
              .filter(function (n) { return !isNaN(n); });
          }
          callback(null, nums);
        } catch (e) {
          callback(new Error('Parse error: ' + e.message));
        }
      } else {
        callback(new Error('HTTP ' + req.status));
      }
    };
    req.onerror = function () { callback(new Error('Network error')); };
    req.send();
  }

  /* ══════════════════════════════════════════════════════
     2.  FETCH INDIVIDUAL PAGE TEXT FILES
     ══════════════════════════════════════════════════════ */
  function fetchPageTexts(nums, progressCallback, callback) {
    var results = {};
    var total   = nums.length;
    var done    = 0;

    if (total === 0) { callback([]); return; }

    nums.forEach(function (n) {
      var url = CONFIG.PAGES_FOLDER + n + '.txt';
      var req = new XMLHttpRequest();
      req.open('GET', url, true);
      req.onload = function () {
        results[n] = (req.status >= 200 && req.status < 300)
          ? req.responseText
          : '(page ' + n + ' not found)';
        done++;
        progressCallback(done / total);
        if (done === total) {
          // Return in the original order
          var ordered = nums.map(function (n) {
            return { num: n, text: results[n] };
          });
          callback(ordered);
        }
      };
      req.onerror = function () {
        results[n] = '(error loading page ' + n + ')';
        done++;
        progressCallback(done / total);
        if (done === total) {
          var ordered = nums.map(function (n) {
            return { num: n, text: results[n] };
          });
          callback(ordered);
        }
      };
      req.send();
    });
  }

  /* ══════════════════════════════════════════════════════
     3.  RENDER A PAGE TO A CANVAS  (used as Three.js texture)
     ══════════════════════════════════════════════════════ */
  function makePageCanvas(pageObj) {
    var W = 768, H = 1024;   // internal canvas resolution
    var c = document.createElement('canvas');
    c.width  = W;
    c.height = H;
    var ctx = c.getContext('2d');

    // background
    ctx.fillStyle = '#f5f0e8';
    ctx.fillRect(0, 0, W, H);

    // subtle top rule
    ctx.fillStyle = '#FF5D00';
    ctx.fillRect(48, 56, W - 96, 2);

    // page number
    ctx.fillStyle = '#FF5D00';
    ctx.font = 'bold 18px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.fillText('— ' + pageObj.num + ' —', 48, 44);

    // body text
    ctx.fillStyle = '#1a1a1a';
    ctx.font = '17px Georgia, serif';
    ctx.textAlign = 'left';
    var lineH   = 26;
    var maxW    = W - 96;
    var startY  = 90;
    var words   = pageObj.text.split(/\s+/);
    var line    = '';
    var y       = startY;
    var maxY    = H - 60;

    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxW && line !== '') {
        ctx.fillText(line, 48, y);
        line = words[i];
        y   += lineH;
        if (y > maxY) break;
      } else {
        line = test;
      }
    }
    if (y <= maxY && line) ctx.fillText(line, 48, y);

    // bottom rule
    ctx.fillStyle = '#FF5D00';
    ctx.fillRect(48, H - 52, W - 96, 1);

    return c;
  }

  /* ══════════════════════════════════════════════════════
     4.  THREE.JS SCENE
     ══════════════════════════════════════════════════════ */
  function initThree() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.setClearColor(0x0d0d0d, 1);
    container.appendChild(renderer.domElement);

    scene  = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.01, 100);
    camera.position.set(0, 0, 4.6);

    /* lights */
    var ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);

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

  /* ── build the static book mesh ── */
  function buildBook() {
    var W = CONFIG.BOOK_WIDTH;
    var H = CONFIG.BOOK_HEIGHT;
    var D = CONFIG.BOOK_DEPTH;

    book = new THREE.Group();
    scene.add(book);

    // ── Cover texture (atlas 3418 × 2048) ──
    var coverTex = new THREE.TextureLoader().load(CONFIG.COVER_TEXTURE, function () {
      renderer.render(scene, camera);
    });
    coverTex.minFilter = THREE.LinearFilter;

    /*  UV helpers: atlas is 3418 wide.
        back  : u 0        … 1536/3418
        spine : u 1536/3418 … 1882/3418
        front : u 1882/3418 … 1
    */
    var T = 3418;
    var uBack0  = 0,         uBack1  = 1536 / T;
    var uSpine0 = 1536 / T,  uSpine1 = 1882 / T;
    var uFront0 = 1882 / T,  uFront1 = 1;

    var accentMat = new THREE.MeshLambertMaterial({ color: CONFIG.ACCENT });
    var coverMat  = new THREE.MeshLambertMaterial({ map: coverTex });

    /* ── Front face ── */
    var frontGeo = makeUVPanel(W, H, uFront0, 0, uFront1, 1);
    var frontMesh = new THREE.Mesh(frontGeo, coverMat);
    frontMesh.position.set(0, 0, D / 2);
    book.add(frontMesh);

    /* ── Back face ── */
    var backGeo  = makeUVPanel(W, H, uBack0, 0, uBack1, 1);
    var backMesh = new THREE.Mesh(backGeo, coverMat);
    backMesh.rotation.y = Math.PI;
    backMesh.position.set(0, 0, -D / 2);
    book.add(backMesh);

    /* ── Spine ── */
    var spineGeo = makeUVPanel(D, H, uSpine0, 0, uSpine1, 1);
    var spineMesh = new THREE.Mesh(spineGeo, coverMat);
    spineMesh.rotation.y = -Math.PI / 2;
    spineMesh.position.set(-W / 2, 0, 0);
    book.add(spineMesh);

    /* ── Top edge ── */
    var topGeo  = new THREE.PlaneGeometry(W, D);
    var topMesh = new THREE.Mesh(topGeo, accentMat);
    topMesh.rotation.x = -Math.PI / 2;
    topMesh.position.set(0, H / 2, 0);
    book.add(topMesh);

    /* ── Bottom edge ── */
    var botMesh = new THREE.Mesh(topGeo.clone(), accentMat);
    botMesh.rotation.x = Math.PI / 2;
    botMesh.position.set(0, -H / 2, 0);
    book.add(botMesh);

    /* ── Right edge (fore-edge / page stack) ── */
    var rightGeo  = new THREE.PlaneGeometry(D, H);
    var rightMesh = new THREE.Mesh(rightGeo, accentMat);
    rightMesh.rotation.y = Math.PI / 2;
    rightMesh.position.set(W / 2, 0, 0);
    book.add(rightMesh);

    /* ── Page stack visible on fore-edge (thin slab) ── */
    var stackGeo  = new THREE.BoxGeometry(0.008, H - 0.01, D - 0.01);
    var stackMesh = new THREE.Mesh(stackGeo, new THREE.MeshLambertMaterial({ color: 0xf0ebe0 }));
    stackMesh.position.set(W / 2 - 0.005, 0, 0);
    book.add(stackMesh);

    /* ── Slight tilt for visual interest ── */
    book.rotation.y = 0.35;
    book.rotation.x = -0.06;

    /* store the display plane for page overlays */
    coverMesh = frontMesh;
  }

  /* helper: PlaneGeometry with custom UVs from atlas */
  function makeUVPanel(w, h, u0, v0, u1, v1) {
    var geo = new THREE.PlaneGeometry(w, h);
    var uv  = geo.attributes.uv;
    // PlaneGeometry default UVs: TL(0,1) TR(1,1) BL(0,0) BR(1,0)
    uv.setXY(0, u0, v1);
    uv.setXY(1, u1, v1);
    uv.setXY(2, u0, v0);
    uv.setXY(3, u1, v0);
    uv.needsUpdate = true;
    return geo;
  }

  /* ── render loop ── */
  function animate() {
    requestAnimationFrame(animate);
    // Gentle idle float
    book.position.y = Math.sin(Date.now() * 0.0008) * 0.018;
    renderer.render(scene, camera);
  }

  /* ══════════════════════════════════════════════════════
     5.  PAGE DISPLAY – swap texture on the front face
     ══════════════════════════════════════════════════════ */

  /* Returns the Two-page spread data for the current index.
     spread 0       → show front cover (no page overlay)
     spread 1…n     → show pages[2*(spread-1)] and pages[2*(spread-1)+1]
     spread maxS    → show back cover
  */
  function getSpreadPages() {
    if (spread === 0 || spread > maxSpreads) return null;
    var idx  = 2 * (spread - 1);
    var left = pages[idx]   || null;
    var right= pages[idx+1] || null;
    return { left: left, right: right };
  }

  function renderSpread() {
    var sp = getSpreadPages();
    if (!sp) {
      // show original cover texture
      applyCoverTexture();
      return;
    }
    // Build a combined canvas: left page | right page
    var W = 1536, H = 1024;
    var canvas = document.createElement('canvas');
    canvas.width  = W * 2;
    canvas.height = H;
    var ctx = canvas.getContext('2d');

    // backgrounds
    ctx.fillStyle = '#e8e2d6';
    ctx.fillRect(0, 0, W * 2, H);

    // gutter shadow
    var grad = ctx.createLinearGradient(W - 18, 0, W + 18, 0);
    grad.addColorStop(0,   'rgba(0,0,0,0.18)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.32)');
    grad.addColorStop(1,   'rgba(0,0,0,0.18)');
    ctx.fillStyle = grad;
    ctx.fillRect(W - 18, 0, 36, H);

    function drawPage(pageObj, offsetX) {
      if (!pageObj) return;
      var pc;
      if (pageCanvases[pageObj.num]) {
        pc = pageCanvases[pageObj.num];
      } else {
        pc = makePageCanvas(pageObj);
        pageCanvases[pageObj.num] = pc;
      }
      // Scale the 768×1024 page canvas into the W×H slot
      ctx.drawImage(pc, offsetX, 0, W, H);
    }

    drawPage(sp.left,  0);
    drawPage(sp.right, W);

    var tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    coverMesh.material = new THREE.MeshLambertMaterial({ map: tex });
    coverMesh.material.needsUpdate = true;
  }

  function applyCoverTexture() {
    var T = 3418;
    var uFront0 = 1882 / T, uFront1 = 1;
    var tex = new THREE.TextureLoader().load(CONFIG.COVER_TEXTURE);
    tex.minFilter = THREE.LinearFilter;
    var geo = makeUVPanel(CONFIG.BOOK_WIDTH, CONFIG.BOOK_HEIGHT, uFront0, 0, uFront1, 1);
    coverMesh.geometry = geo;
    coverMesh.material = new THREE.MeshLambertMaterial({ map: tex });
    coverMesh.material.needsUpdate = true;
  }

  /* ══════════════════════════════════════════════════════
     6.  PAGE TURN ANIMATION  (Y-axis flip of book)
     ══════════════════════════════════════════════════════ */
  function turnTo(nextSpread, direction) {
    if (animating) return;
    if (nextSpread < 0 || nextSpread > maxSpreads + 1) return;
    animating = true;

    var startY  = book.rotation.y;
    var flipAmt = direction > 0 ? -0.55 : 0.55;
    var midY    = startY + flipAmt;
    var endY    = startY;   // return to same angle after swap
    var start   = null;
    var half    = CONFIG.TURN_DURATION / 2;

    function step(ts) {
      if (!start) start = ts;
      var elapsed = ts - start;

      if (elapsed < half) {
        // first half: tilt away
        var t = elapsed / half;
        book.rotation.y = startY + flipAmt * ease(t);
      } else if (elapsed < CONFIG.TURN_DURATION) {
        // swap page at mid-point (once)
        if (spread !== nextSpread) {
          spread = nextSpread;
          renderSpread();
          updateUI();
        }
        // second half: return
        var t = (elapsed - half) / half;
        book.rotation.y = midY + (endY - midY) * ease(t);
      } else {
        book.rotation.y = endY;
        spread     = nextSpread;
        animating  = false;
        renderSpread();
        updateUI();
        return;
      }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function ease(t) {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  function goNext() {
    if (spread < maxSpreads + 1) turnTo(spread + 1, 1);
  }

  function goPrev() {
    if (spread > 0) turnTo(spread - 1, -1);
  }

  /* ══════════════════════════════════════════════════════
     7.  UI  helpers
     ══════════════════════════════════════════════════════ */
  function updateUI() {
    if (spread === 0) {
      pageInfoEl.textContent = 'Front Cover';
    } else if (spread > maxSpreads) {
      pageInfoEl.textContent = 'Back Cover';
    } else {
      var sp = getSpreadPages();
      var nums = [];
      if (sp.left)  nums.push(sp.left.num);
      if (sp.right) nums.push(sp.right.num);
      pageInfoEl.textContent = nums.length ? 'Page ' + nums.join(' – ') : '';
    }
  }

  function setProgress(pct) {
    fillEl.style.width = Math.round(pct * 100) + '%';
  }

  function hideLoading() {
    loadingEl.style.transition = 'opacity 0.5s';
    loadingEl.style.opacity    = '0';
    setTimeout(function () { loadingEl.style.display = 'none'; }, 500);
  }

  /* ══════════════════════════════════════════════════════
     8.  INPUT
     ══════════════════════════════════════════════════════ */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') goNext();
    if (e.key === 'ArrowLeft')  goPrev();
  });

  document.getElementById('click-right').addEventListener('click', goNext);
  document.getElementById('click-left').addEventListener('click',  goPrev);

  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* ══════════════════════════════════════════════════════
     9.  BOOT SEQUENCE
     ══════════════════════════════════════════════════════ */
  function boot() {
    initThree();
    setProgress(0.05);

    fetchPageList(function (err, nums) {
      if (err || !nums || nums.length === 0) {
        // Graceful fallback: show cover-only book with no pages
        console.warn('Could not load page list from Google Sheets:', err);
        pages      = [];
        maxSpreads = 0;
        updateUI();
        hideLoading();
        return;
      }

      setProgress(0.15);

      fetchPageTexts(nums, function (frac) {
        setProgress(0.15 + frac * 0.8);
      }, function (loadedPages) {
        pages      = loadedPages;
        maxSpreads = Math.ceil(pages.length / 2);  // each spread shows 2 pages

        updateUI();
        hideLoading();
      });
    });
  }

  boot();

})();
