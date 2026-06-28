/**
 * 3D Book Viewer — complete rewrite
 *
 * Architecture:
 *   CLOSED state  : solid book box centred on origin
 *   OPEN state    : left cover fixed, right cover fixed, page leaf group
 *                   pivots 180° around the spine (left edge of right panel)
 *
 * Page layout:
 *   Each physical "leaf" has a recto (right-hand, odd) and verso (left-hand, even)
 *   face.  When you turn a page the leaf sweeps from right → left.
 *
 *   Spread 0        = front cover visible (closed book)
 *   Spread 1        = pages 1 (right) and nothing (left — back of cover)
 *   Spread 2        = pages 2 (left) | 3 (right)
 *   Spread n        = pages 2n-2 (left) | 2n-1 (right)   for n >= 2
 *   Spread maxS+1   = back cover (closed book reversed)
 *
 * Controls:
 *   Mouse drag   orbit   |  Scroll  zoom
 *   ← →          turn pages
 *   W / A / D    pitch / yaw book
 *   P            cycle camera presets
 *   R            reset
 */

var CONFIG = {
  PAGES_FOLDER : 'pages/',
  COVER_TEXTURE: 'cover.png',
  // Image extensions to probe, in priority order
  IMG_EXTS     : ['png', 'jpg', 'jpeg', 'webp'],
  // How many pages to scan before giving up (stops at first 404)
  MAX_PAGES    : 500,
  // Book units (Three.js)
  BW : 1.536,   // cover width
  BH : 2.048,   // cover height
  BD : 0.18,    // spine depth (thickness of closed book)
  ACCENT       : 0xFF5D00,
  TURN_MS      : 700,
};

(function () {
  'use strict';

  /* ── state ── */
  var pages       = [];   // [{num, type:'image', url}, …] ordered
  var spread      = 0;    // current spread index (0 = front cover closed)
  var maxSpreads  = 0;    // = ceil(pages.length / 2)
  var animating   = false;
  var bookOpen    = false;

  /* ── Three.js ── */
  var renderer, scene, camera;
  var pageCanvasCache = {};

  /* ── scene objects ── */
  var closedBook;          // Group  – the solid box (shown when closed)
  var openBook;            // Group  – left cover + right cover + pages (shown when open)
  var leftCoverMesh;       // the left panel (spine side) – stationary
  var rightCoverMesh;      // the right panel (fore-edge side) – stationary
  var pageLeaf;            // Group  – current turning leaf; pivots at left edge (spine side)
  var pageLeafFront;       // Mesh   – recto face of leaf (right page)
  var pageLeafBack;        // Mesh   – verso face of leaf (left page of NEXT spread)

  /* ── camera / orbit ── */
  var orbit = { dragging:false, lastX:0, lastY:0, theta:0.25, phi:0.1, radius:5.5,
                phiMin:-Math.PI/2+0.05, phiMax:Math.PI/2-0.05 };
  var bookRot = { x: 0, y: 0 };
  var CAM_PRESETS = [
    { theta:0.25,  phi:0.1,  r:5.5, name:'Default' },
    { theta:0,     phi:0,    r:5.5, name:'Front'   },
    { theta:Math.PI, phi:0,  r:5.5, name:'Back'    },
    { theta:-Math.PI/2, phi:0, r:5.5, name:'Spine' },
    { theta:0.25,  phi:Math.PI/2-0.1, r:5.5, name:'Top' },
  ];
  var camPresetIdx = 0;

  /* ── DOM ── */
  var loadingEl  = document.getElementById('loading');
  var fillEl     = document.getElementById('loading-bar-fill');
  var pageInfoEl = document.getElementById('page-info');
  var container  = document.getElementById('canvas-container');

  /* ══════════════════════════════════════════════════
     IMAGE DISCOVERY
     Probes pages/1.png, pages/1.jpg … for each page number
     sequentially until a number yields no file, then stops.
  ══════════════════════════════════════════════════ */

  /** Probe a single page number; calls cb({num,type:'image',url}) or cb(null) */
  function probePageNum(n, cb) {
    var exts = CONFIG.IMG_EXTS.slice();
    function tryNext() {
      if (!exts.length) { cb(null); return; }
      var ext = exts.shift();
      var url = CONFIG.PAGES_FOLDER + n + '.' + ext;
      var req = new XMLHttpRequest();
      req.open('HEAD', url, true);
      req.onload = function() {
        if (req.status >= 200 && req.status < 300) cb({ num: n, type: 'image', url: url });
        else tryNext();
      };
      req.onerror = tryNext;
      req.send();
    }
    tryNext();
  }

  /**
   * Discover all page images by probing 1, 2, 3 … sequentially.
   * Stops when a number has no matching image file.
   * onProg(fraction) called during scan; cb(pagesArray) when done.
   */
  function discoverPages(onProg, cb) {
    var found = [];
    var n = 1;
    function next() {
      if (n > CONFIG.MAX_PAGES) { cb(found); return; }
      probePageNum(n, function(pageObj) {
        if (!pageObj) {
          // Gap found — stop scanning
          cb(found);
        } else {
          found.push(pageObj);
          onProg(found.length / CONFIG.MAX_PAGES); // rough progress
          n++;
          next();
        }
      });
    }
    next();
  }

  /* ══════════════════════════════════════════════════
     PAGE CANVAS – paper coloured, dark text
  ══════════════════════════════════════════════════ */
  function makePageCanvas(pageObj) {
    var W=768, H=1024;
    var c=document.createElement('canvas');
    c.width=W; c.height=H;
    var ctx=c.getContext('2d');

    // paper background
    ctx.fillStyle='#f2ece0';
    ctx.fillRect(0,0,W,H);

    // top rule
    ctx.fillStyle='#FF5D00';
    ctx.fillRect(44,58,W-88,2);

    // page number
    ctx.fillStyle='#FF5D00';
    ctx.font='bold 16px Georgia,serif';
    ctx.textAlign='center';
    ctx.fillText(pageObj.num, W/2, 46);

    // body text – DARK colour explicitly set
    ctx.fillStyle='#1c1008';
    ctx.font='16px Georgia,serif';
    ctx.textAlign='left';
    var lh=25, mw=W-88, x=44, y=84, maxY=H-56;
    var words=(pageObj.text||'').split(/\s+/), line='';
    for(var i=0;i<words.length;i++){
      if(!words[i]) continue;
      var test=line?line+' '+words[i]:words[i];
      if(ctx.measureText(test).width>mw && line){
        ctx.fillText(line,x,y); line=words[i]; y+=lh;
        if(y>maxY){ctx.fillText('…',x,y);break;}
      } else line=test;
    }
    if(y<=maxY&&line) ctx.fillText(line,x,y);

    // bottom rule
    ctx.fillStyle='#FF5D00';
    ctx.fillRect(44,H-46,W-88,1);
    return c;
  }

  function getPageCanvas(pageObj){
    // All pages are images now; blank canvas only as a fallback
    return makeBlankCanvas();
  }

  function makeBlankCanvas(){
    var c=document.createElement('canvas'); c.width=768; c.height=1024;
    var ctx=c.getContext('2d');
    ctx.fillStyle='#f2ece0'; ctx.fillRect(0,0,768,1024);
    return c;
  }

  /* Returns a THREE.Texture for a page object (image or text canvas) */
  function singlePageTex(pageObj){
    if(!pageObj){
      var blank=new THREE.CanvasTexture(makeBlankCanvas());
      blank.minFilter=THREE.LinearFilter;
      return blank;
    }
    if(pageObj.type==='image'){
      // Use TextureLoader so Three.js handles image decoding; cache by url
      if(!pageCanvasCache['__tex_'+pageObj.num]){
        var t=new THREE.TextureLoader().load(pageObj.url);
        t.minFilter=THREE.LinearFilter;
        pageCanvasCache['__tex_'+pageObj.num]=t;
      }
      return pageCanvasCache['__tex_'+pageObj.num];
    }
    // text-based page
    var canvas=getPageCanvas(pageObj);
    var tex=new THREE.CanvasTexture(canvas);
    tex.minFilter=THREE.LinearFilter;
    return tex;
  }

  /* ══════════════════════════════════════════════════
     SCENE INIT
  ══════════════════════════════════════════════════ */
  function initThree(){
    renderer=new THREE.WebGLRenderer({antialias:true});
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth,window.innerHeight);
    renderer.shadowMap.enabled=true;
    renderer.setClearColor(0x0d0d0d,1);
    container.appendChild(renderer.domElement);

    scene=new THREE.Scene();
    camera=new THREE.PerspectiveCamera(40,window.innerWidth/window.innerHeight,0.01,100);
    updateCamera();

    scene.add(new THREE.AmbientLight(0xffffff,0.6));
    var key=new THREE.DirectionalLight(0xffffff,0.85); key.position.set(3,5,4); scene.add(key);
    var fill=new THREE.DirectionalLight(0xffeedd,0.25); fill.position.set(-3,1,3); scene.add(fill);
    var back=new THREE.DirectionalLight(0xffffff,0.15); back.position.set(0,-2,-4); scene.add(back);

    buildClosedBook();
    buildOpenBook();

    // start closed
    openBook.visible=false;

    animate();
  }

  function updateCamera(){
    var r=orbit.radius;
    camera.position.set(
      r*Math.sin(orbit.theta)*Math.cos(orbit.phi),
      r*Math.sin(orbit.phi),
      r*Math.cos(orbit.theta)*Math.cos(orbit.phi)
    );
    camera.lookAt(0,0,0);
  }

  /* ══════════════════════════════════════════════════
     CLOSED BOOK  –  simple box with atlas UV
  ══════════════════════════════════════════════════ */
  function buildClosedBook(){
    var BW=CONFIG.BW, BH=CONFIG.BH, BD=CONFIG.BD;
    closedBook=new THREE.Group();
    scene.add(closedBook);

    var loader=new THREE.TextureLoader();
    var coverTex=loader.load(CONFIG.COVER_TEXTURE);
    coverTex.minFilter=THREE.LinearFilter;

    var T=3418;
    var uB0=0, uB1=1536/T;          // back
    var uS0=1536/T, uS1=1882/T;     // spine
    var uF0=1882/T, uF1=1;          // front

    var accentMat=new THREE.MeshLambertMaterial({color:CONFIG.ACCENT});
    var coverMat =new THREE.MeshLambertMaterial({map:coverTex});

    // +Z face = front cover
    var front=makePlane(BW,BH,uF0,0,uF1,1,coverMat);
    front.position.set(0,0,BD/2); closedBook.add(front);

    // -Z face = back cover
    var back=makePlane(BW,BH,uB0,0,uB1,1,coverMat);
    back.rotation.y=Math.PI; back.position.set(0,0,-BD/2); closedBook.add(back);

    // -X face = spine
    var spine=makePlane(BD,BH,uS0,0,uS1,1,coverMat);
    spine.rotation.y=-Math.PI/2; spine.position.set(-BW/2,0,0); closedBook.add(spine);

    // +X face = fore-edge
    var fore=new THREE.Mesh(new THREE.PlaneGeometry(BD,BH),accentMat);
    fore.rotation.y=Math.PI/2; fore.position.set(BW/2,0,0); closedBook.add(fore);

    // top/bottom
    var topG=new THREE.PlaneGeometry(BW,BD);
    var top=new THREE.Mesh(topG,accentMat); top.rotation.x=-Math.PI/2; top.position.set(0,BH/2,0); closedBook.add(top);
    var bot=new THREE.Mesh(topG.clone(),accentMat); bot.rotation.x=Math.PI/2; bot.position.set(0,-BH/2,0); closedBook.add(bot);

    // page stack sliver on fore-edge
    var stack=new THREE.Mesh(new THREE.BoxGeometry(0.012,BH-0.02,BD-0.02),
      new THREE.MeshLambertMaterial({color:0xede8da}));
    stack.position.set(BW/2-0.007,0,0); closedBook.add(stack);

    closedBook.rotation.y=0.3;
    closedBook.rotation.x=-0.05;
  }

  /* ══════════════════════════════════════════════════
     OPEN BOOK  –  left panel + right panel + leaf
     The spine is at x=0.  Left panel extends to -BW.
     Right panel extends to +BW.
  ══════════════════════════════════════════════════ */
  function buildOpenBook(){
    var BW=CONFIG.BW, BH=CONFIG.BH, BD=CONFIG.BD;
    openBook=new THREE.Group();
    scene.add(openBook);

    var loader=new THREE.TextureLoader();
    var coverTex=loader.load(CONFIG.COVER_TEXTURE);
    coverTex.minFilter=THREE.LinearFilter;

    var T=3418;
    var accentMat=new THREE.MeshLambertMaterial({color:CONFIG.ACCENT,side:THREE.DoubleSide});
    var pageMat  =new THREE.MeshLambertMaterial({color:0xede8da,    side:THREE.DoubleSide});
    var coverMat =new THREE.MeshLambertMaterial({map:coverTex,      side:THREE.DoubleSide});

    // ── Left panel (back of front cover / even pages face outward to left) ──
    // Centred at (-BW/2, 0, 0)
    leftCoverMesh=new THREE.Mesh(new THREE.PlaneGeometry(BW,BH),
      new THREE.MeshLambertMaterial({color:CONFIG.ACCENT,side:THREE.DoubleSide}));
    leftCoverMesh.position.set(-BW/2,0,0);
    openBook.add(leftCoverMesh);

    // ── Right panel (front cover shown when spread=0, pages shown when open) ──
    rightCoverMesh=new THREE.Mesh(new THREE.PlaneGeometry(BW,BH),
      new THREE.MeshLambertMaterial({map:coverTex,side:THREE.DoubleSide}));
    rightCoverMesh.position.set(BW/2,0,0);
    openBook.add(rightCoverMesh);

    // ── Spine strip ──
    var spineG=makePlane(0.04,BH,1536/T,0,1882/T,1,coverMat);
    spineG.rotation=undefined;
    var spineM=new THREE.Mesh(new THREE.PlaneGeometry(0.04,BH),coverMat);
    spineM.position.set(0,0,0.001);
    openBook.add(spineM);

    // ── Page leaf group – pivot point at x=0 (spine) ──
    // The leaf is a flat double-sided plane of width BW, centred at (BW/2, 0, 0)
    // relative to the leaf group.  The leaf group itself sits at x=0.
    // Rotating leafGroup.rotation.y from 0 → π sweeps right-to-left.
    pageLeaf=new THREE.Group();
    pageLeaf.position.set(0,0,0.002); // tiny z-offset so it's in front of panels
    openBook.add(pageLeaf);

    // recto (front face of leaf, right-hand page) – faces +Z when y-rotation=0
    pageLeafFront=new THREE.Mesh(new THREE.PlaneGeometry(BW,BH),
      new THREE.MeshLambertMaterial({color:0xede8da,side:THREE.FrontSide}));
    pageLeafFront.position.set(BW/2,0,0.001);
    pageLeaf.add(pageLeafFront);

    // verso (back face, left-hand page) – faces -Z when y-rotation=0, becomes visible after flip
    pageLeafBack=new THREE.Mesh(new THREE.PlaneGeometry(BW,BH),
      new THREE.MeshLambertMaterial({color:0xede8da,side:THREE.BackSide}));
    pageLeafBack.position.set(BW/2,0,-0.001);
    pageLeaf.add(pageLeafBack);

    // ── Top/Bottom edges of open book ──
    var edgeMat=new THREE.MeshLambertMaterial({color:CONFIG.ACCENT});
    var topEdge=new THREE.Mesh(new THREE.PlaneGeometry(BW*2,0.01),edgeMat);
    topEdge.rotation.x=-Math.PI/2; topEdge.position.set(0,BH/2,0); openBook.add(topEdge);
    var botEdge=new THREE.Mesh(new THREE.PlaneGeometry(BW*2,0.01),edgeMat);
    botEdge.rotation.x=Math.PI/2; botEdge.position.set(0,-BH/2,0); openBook.add(botEdge);

    openBook.rotation.y=0.1;
    openBook.rotation.x=-0.05;
  }

  function makePlane(w,h,u0,v0,u1,v1,mat){
    var geo=new THREE.PlaneGeometry(w,h);
    var uv=geo.attributes.uv;
    uv.setXY(0,u0,v1); uv.setXY(1,u1,v1);
    uv.setXY(2,u0,v0); uv.setXY(3,u1,v0);
    uv.needsUpdate=true;
    return new THREE.Mesh(geo,mat);
  }

  /* ══════════════════════════════════════════════════
     RENDER LOOP
  ══════════════════════════════════════════════════ */
  function animate(){
    requestAnimationFrame(animate);
    var t=Date.now()*0.0008;
    if(closedBook.visible) closedBook.position.y=Math.sin(t)*0.02;
    if(openBook.visible)   openBook.position.y  =Math.sin(t)*0.015;
    renderer.render(scene,camera);
  }

  /* ══════════════════════════════════════════════════
     SPREAD DATA
     ──────────────────────────────────────────────────
     pages[] = [{num:1,text},{num:2,text},{num:3,text},…]
     spread 0        : closed (front cover)
     spread 1        : open, left=blank(back of cover), right=pages[0] (page 1)
     spread 2        : left=pages[1] (p2), right=pages[2] (p3)
     spread n≥2      : left=pages[2n-3] (even), right=pages[2n-2] (odd)
     spread maxS     : left=pages[last], right=blank
     spread maxS+1   : closed (back cover)
  ══════════════════════════════════════════════════ */
  function getSpreadData(s){
    if(s<=0||s>maxSpreads) return null;
    var leftPage=null, rightPage=null;
    if(s===1){
      rightPage=pages[0]||null;
    } else {
      var li=2*(s-1)-1; // index into pages[]
      var ri=li+1;
      leftPage =pages[li]||null;
      rightPage=pages[ri]||null;
    }
    return{left:leftPage, right:rightPage};
  }

  /* ══════════════════════════════════════════════════
     OPEN / CLOSE TRANSITIONS
  ══════════════════════════════════════════════════ */
  function showClosed(useFront){
    // swap to closed book
    openBook.visible=false;
    closedBook.visible=true;
    // copy rotation
    closedBook.rotation.x=bookRot.x-0.05;
    closedBook.rotation.y=bookRot.y+(useFront?0.3:-Math.PI+0.3);
  }

  function showOpen(){
    closedBook.visible=false;
    openBook.visible=true;
    openBook.rotation.x=bookRot.x-0.05;
    openBook.rotation.y=bookRot.y+0.1;
  }

  /* ══════════════════════════════════════════════════
     APPLY TEXTURES TO OPEN BOOK PANELS
  ══════════════════════════════════════════════════ */
  var coverTexCached=null;
  function getCoverTex(){
    if(!coverTexCached){
      coverTexCached=new THREE.TextureLoader().load(CONFIG.COVER_TEXTURE);
      coverTexCached.minFilter=THREE.LinearFilter;
    }
    return coverTexCached;
  }

  function applySpread(s){
    var sd=getSpreadData(s);
    if(!sd) return;

    // Left panel texture
    if(sd.left){
      leftCoverMesh.material=new THREE.MeshLambertMaterial({map:singlePageTex(sd.left),side:THREE.DoubleSide});
    } else {
      // back of front cover = accent colour
      leftCoverMesh.material=new THREE.MeshLambertMaterial({color:CONFIG.ACCENT,side:THREE.DoubleSide});
    }

    // Right panel texture (shows right page of this spread, or front cover if first)
    if(s===1 && !sd.right){
      rightCoverMesh.material=new THREE.MeshLambertMaterial({map:getCoverTex(),side:THREE.DoubleSide});
    } else if(sd.right){
      rightCoverMesh.material=new THREE.MeshLambertMaterial({map:singlePageTex(sd.right),side:THREE.DoubleSide});
    } else {
      rightCoverMesh.material=new THREE.MeshLambertMaterial({color:0xede8da,side:THREE.DoubleSide});
    }

    leftCoverMesh.material.needsUpdate=true;
    rightCoverMesh.material.needsUpdate=true;
  }

  /* Set what the turning leaf displays
     leafFrontPage = the page that shows on the recto (right-hand face) as leaf starts
     leafBackPage  = the page shown on the verso (left-hand face) after flip completes */
  function setLeafTextures(frontPage, backPage){
    pageLeafFront.material=new THREE.MeshLambertMaterial({
      map:singlePageTex(frontPage), side:THREE.FrontSide});
    pageLeafBack.material=new THREE.MeshLambertMaterial({
      map:singlePageTex(backPage),  side:THREE.BackSide});
    pageLeafFront.material.needsUpdate=true;
    pageLeafBack.material.needsUpdate=true;
  }

  /* ══════════════════════════════════════════════════
     PAGE TURN — the leaf pivots Y: 0 → π (forward) or π → 0 (backward)
  ══════════════════════════════════════════════════ */
  function turnTo(nextSpread, dir){
    if(animating) return;
    if(nextSpread<0||nextSpread>maxSpreads+1) return;
    animating=true;

    var HALF=CONFIG.TURN_MS/2;

    // ── going forward (dir=1): spread → spread+1 ──
    // ── going backward (dir=-1): spread → spread-1 ──

    // Determine open→open, open→close, close→open transitions
    var fromClosed=(spread===0||(spread===maxSpreads+1));
    var toClosed=(nextSpread===0||(nextSpread===maxSpreads+1));

    if(fromClosed && toClosed){
      // both closed – shouldn't happen but just update
      spread=nextSpread; animating=false; updateUI(); return;
    }

    if(fromClosed){
      // animate: closed book opens
      showOpen();
      applySpread(nextSpread);
      // hide leaf initially (no leaf needed when just opening)
      pageLeaf.visible=false;
      // animate openBook.rotation.y from 'closed angle' to open angle
      var startY=openBook.rotation.y+(dir>0? 0.5 : -0.5);
      var endY=openBook.rotation.y;
      var t0=null;
      openBook.rotation.y=startY;
      (function step(ts){
        if(!t0)t0=ts;
        var prog=Math.min((ts-t0)/CONFIG.TURN_MS,1);
        openBook.rotation.y=startY+(endY-startY)*ease(prog);
        if(prog<1){requestAnimationFrame(step);}
        else{spread=nextSpread;animating=false;updateUI();}
      })(performance.now());
      return;
    }

    if(toClosed){
      // animate book closing
      var startY2=openBook.rotation.y;
      var endY2=openBook.rotation.y+(dir>0? -0.5:0.5);
      var t1=null;
      pageLeaf.visible=false;
      (function step(ts){
        if(!t1)t1=ts;
        var prog=Math.min((ts-t1)/CONFIG.TURN_MS,1);
        openBook.rotation.y=startY2+(endY2-startY2)*ease(prog);
        if(prog<1){requestAnimationFrame(step);}
        else{
          spread=nextSpread;animating=false;
          showClosed(nextSpread===0);
          updateUI();
        }
      })(performance.now());
      return;
    }

    // ── open → open: animate a page leaf ──
    showOpen();
    pageLeaf.visible=true;

    // What the leaf shows depends on direction
    // Forward: leaf starts on the right, showing current spread's right page on its front
    //          and the next spread's left page on its back
    // Backward: leaf starts on the left (y=π), showing next spread's right page on its back
    //           and current spread's left page on its front (will be revealed)

    var curSD=getSpreadData(spread);
    var nxtSD=getSpreadData(nextSpread);

    if(dir>0){
      // leaf front = right page of current spread
      // leaf back  = left page of next spread
      var lf=curSD ? curSD.right : null;
      var lb=nxtSD ? nxtSD.left  : null;
      setLeafTextures(lf,lb);
      pageLeaf.rotation.y=0;          // start: leaf covering right panel
      // during animation: right panel should show nothing (leaf is on top)
      // after animation:  left panel gets next left, right panel gets next right
      applySpread(spread); // keep current spread visible under the leaf
    } else {
      // leaf front = left page of next spread (will flip to reveal it)
      // leaf back  = right page of current spread
      var lf2=nxtSD ? nxtSD.right : null;
      var lb2=curSD ? curSD.left  : null;
      setLeafTextures(lf2,lb2);
      pageLeaf.rotation.y=Math.PI;    // start: leaf already over left panel (rotated)
      applySpread(spread);
    }

    var startRot=dir>0?0:Math.PI;
    var endRot  =dir>0?Math.PI:0;
    var t2=null;
    var swapped=false;

    (function step(ts){
      if(!t2)t2=ts;
      var prog=Math.min((ts-t2)/CONFIG.TURN_MS,1);
      pageLeaf.rotation.y=startRot+(endRot-startRot)*ease(prog);

      // At midpoint, swap the static panels to the next spread
      if(!swapped && prog>=0.5){
        swapped=true;
        applySpread(nextSpread);
      }

      if(prog<1){
        requestAnimationFrame(step);
      } else {
        pageLeaf.rotation.y=endRot;
        pageLeaf.visible=false;
        spread=nextSpread;
        animating=false;
        applySpread(nextSpread);
        updateUI();
      }
    })(performance.now());
  }

  function ease(t){return t<0.5?2*t*t:-1+(4-2*t)*t;}
  function goNext(){if(!animating&&spread<maxSpreads+1)turnTo(spread+1,1);}
  function goPrev(){if(!animating&&spread>0)turnTo(spread-1,-1);}

  /* ══════════════════════════════════════════════════
     UI
  ══════════════════════════════════════════════════ */
  function updateUI(){
    if(spread===0){
      pageInfoEl.textContent='Front Cover';
    } else if(spread>maxSpreads){
      pageInfoEl.textContent='Back Cover';
    } else {
      var sd=getSpreadData(spread);
      var parts=[];
      if(sd&&sd.left)  parts.push(sd.left.num);
      if(sd&&sd.right) parts.push(sd.right.num);
      pageInfoEl.textContent=parts.length?'Pages '+parts.join(' & '):'';
    }
  }

  var hintTO;
  function showHint(txt){
    pageInfoEl.textContent=txt;
    clearTimeout(hintTO);
    hintTO=setTimeout(updateUI,1600);
  }

  function setProgress(p){fillEl.style.width=Math.round(p*100)+'%';}
  function hideLoading(){
    loadingEl.style.transition='opacity 0.5s';
    loadingEl.style.opacity='0';
    setTimeout(function(){loadingEl.style.display='none';},500);
  }

  /* ══════════════════════════════════════════════════
     INPUT
  ══════════════════════════════════════════════════ */
  var WAD=0.04;
  document.addEventListener('keydown',function(e){
    switch(e.key){
      case 'ArrowRight': goNext(); break;
      case 'ArrowLeft':  goPrev(); break;
      case 'w': case 'W': bookRot.x-=WAD; applyBookRot(); break;
      case 'a': case 'A': bookRot.y-=WAD; applyBookRot(); break;
      case 'd': case 'D': bookRot.y+=WAD; applyBookRot(); break;
      case 'p': case 'P': cyclePreset(); break;
      case 'r': case 'R': resetView();   break;
    }
  });

  function applyBookRot(){
    var bx=bookRot.x-0.05, by=bookRot.y;
    if(closedBook.visible){ closedBook.rotation.x=bx; closedBook.rotation.y=by+0.3; }
    if(openBook.visible)  { openBook.rotation.x=bx;   openBook.rotation.y=by+0.1;  }
  }

  // Mouse orbit
  document.addEventListener('mousedown',function(e){
    if(e.button!==0)return;
    orbit.dragging=true; orbit.lastX=e.clientX; orbit.lastY=e.clientY;
    document.body.style.cursor='grabbing';
  });
  document.addEventListener('mousemove',function(e){
    if(!orbit.dragging)return;
    var dx=e.clientX-orbit.lastX, dy=e.clientY-orbit.lastY;
    orbit.lastX=e.clientX; orbit.lastY=e.clientY;
    orbit.theta-=dx*0.005;
    orbit.phi  +=dy*0.005;
    orbit.phi=Math.max(orbit.phiMin,Math.min(orbit.phiMax,orbit.phi));
    updateCamera();
  });
  document.addEventListener('mouseup',   function(){orbit.dragging=false;document.body.style.cursor='';});
  document.addEventListener('mouseleave',function(){orbit.dragging=false;document.body.style.cursor='';});

  // Scroll zoom
  document.addEventListener('wheel',function(e){
    e.preventDefault();
    orbit.radius+=e.deltaY*0.005;
    orbit.radius=Math.max(1.5,Math.min(14,orbit.radius));
    updateCamera();
  },{passive:false});

  // Touch
  var t0=null,tDist=null;
  document.addEventListener('touchstart',function(e){
    if(e.touches.length===1) t0={x:e.touches[0].clientX,y:e.touches[0].clientY};
    else if(e.touches.length===2) tDist=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
  },{passive:true});
  document.addEventListener('touchmove',function(e){
    if(e.touches.length===1&&t0){
      var dx=e.touches[0].clientX-t0.x,dy=e.touches[0].clientY-t0.y;
      t0={x:e.touches[0].clientX,y:e.touches[0].clientY};
      orbit.theta-=dx*0.007; orbit.phi+=dy*0.007;
      orbit.phi=Math.max(orbit.phiMin,Math.min(orbit.phiMax,orbit.phi));
      updateCamera();
    } else if(e.touches.length===2&&tDist){
      var d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
      orbit.radius*=tDist/d; orbit.radius=Math.max(1.5,Math.min(14,orbit.radius));
      tDist=d; updateCamera();
    }
    e.preventDefault();
  },{passive:false});
  document.addEventListener('touchend',function(){t0=null;tDist=null;});

  // Resize
  window.addEventListener('resize',function(){
    camera.aspect=window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth,window.innerHeight);
  });

  /* ══════════════════════════════════════════════════
     CAMERA PRESETS & RESET
  ══════════════════════════════════════════════════ */
  function cyclePreset(){
    camPresetIdx=(camPresetIdx+1)%CAM_PRESETS.length;
    var p=CAM_PRESETS[camPresetIdx];
    orbit.theta=p.theta; orbit.phi=p.phi; orbit.radius=p.r;
    updateCamera();
    showHint(p.name+' view');
  }

  function resetView(){
    var p=CAM_PRESETS[0];
    orbit.theta=p.theta; orbit.phi=p.phi; orbit.radius=p.r;
    bookRot.x=0; bookRot.y=0;
    updateCamera(); applyBookRot();
    camPresetIdx=0;
    showHint('Reset');
  }

  /* ══════════════════════════════════════════════════
     BOOT
  ══════════════════════════════════════════════════ */
  function boot(){
    initThree();
    setProgress(0.05);

    console.log('[Book] scanning for page images in', CONFIG.PAGES_FOLDER);
    discoverPages(
      function(f){ setProgress(0.1 + f * 0.85); },
      function(loaded){
        pages = loaded;
        console.log('[Book] found', pages.length, 'page image(s)');
        if (!pages.length) {
          console.warn('[Book] no page images found – check that pages/1.png (or .jpg/.jpeg/.webp) exists');
        }
        maxSpreads = Math.ceil((pages.length + 1) / 2);
        setProgress(1);
        updateUI();
        hideLoading();
      }
    );
  }

  boot();
})();
