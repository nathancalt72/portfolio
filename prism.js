/**
 * prism.js — 3D glass cube, screen-space refraction
 * Three.js 0.134 · 3-pass: bgRT → glassRT → CA → screen
 */
;(function () {
  'use strict';

  var heroEl = document.getElementById('hero');
  if (!heroEl) return;
  if (window.matchMedia('(hover: none)').matches) return;

  var loaded = false;
  new IntersectionObserver(function (entries, obs) {
    if (entries[0].isIntersecting && !loaded) {
      loaded = true;
      obs.disconnect();
      if (window.THREE) { setup(); return; }
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/three@0.134.0/build/three.min.js';
      s.onload  = setup;
      s.onerror = function () { console.warn('[prism] Three.js failed'); };
      document.head.appendChild(s);
    }
  }, { threshold: 0.05 }).observe(heroEl);

  function setup() {
    var THREE = window.THREE;

    var wrap = document.createElement('div');
    wrap.id = 'prism-wrap';
    heroEl.appendChild(wrap);

    requestAnimationFrame(function () {
      var W = wrap.offsetWidth;
      var H = wrap.offsetHeight;
      if (!W || !H) { W = 400; H = 400; }
      var DPR = Math.min(window.devicePixelRatio, 1.5);
      var rtW = Math.max(1, Math.round(W * DPR));
      var rtH = Math.max(1, Math.round(H * DPR));

      var canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:100%;height:100%;display:block;';
      wrap.appendChild(canvas);

      var renderer = new THREE.WebGLRenderer({
        canvas:          canvas,
        alpha:           true,   // transparent outside cube
        antialias:       true,
        powerPreference: 'high-performance'
      });
      renderer.setPixelRatio(DPR);
      renderer.setSize(W, H);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = false;

      var camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 100);
      camera.position.z = 5.5;

      // ── PASS 1: background scene → bgRT ──────────────────────────────────
      // Renders hero-bg-web.jpg onto a plane that exactly fills the frustum.
      // The glass shader samples this RT to fake refraction.

      var bgScene = new THREE.Scene();

      function frustumPlane(w, h) {
        var dist = camera.position.z + 10; // camera to plane = 15.5
        var pH = 2 * Math.tan(Math.PI / 9) * dist; // tan(20°)
        var pW = pH * (w / h);
        return new THREE.PlaneGeometry(pW, pH);
      }

      function coverUV(tex, w, h) {
        var ia = 1920 / 908, ca = w / h;
        if (ca > ia) {
          tex.repeat.set(1, ia / ca);
          tex.offset.set(0, (1 - ia / ca) * 0.5);
        } else {
          tex.repeat.set(ca / ia, 1);
          tex.offset.set((1 - ca / ia) * 0.5, 0);
        }
        tex.needsUpdate = true;
      }

      var bgMat = new THREE.MeshBasicMaterial({
        color:      0x080a09,
        depthTest:  false,
        depthWrite: false
      });
      var bgPlane = new THREE.Mesh(frustumPlane(W, H), bgMat);
      bgPlane.position.z = -10;
      bgScene.add(bgPlane);

      var heroTex = null;
      new THREE.TextureLoader().load('hero-bg-web.jpg', function (tex) {
        heroTex = tex;
        bgMat.map = tex;
        bgMat.color.set(0xffffff);
        bgMat.needsUpdate = true;
        coverUV(tex, W, H);
      });

      var bgRT = new THREE.WebGLRenderTarget(rtW, rtH, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat, stencilBuffer: false
      });

      // ── PASS 2: glass cube scene → glassRT ───────────────────────────────
      // Custom shader: computes refract() per fragment, samples bgRT at the
      // distorted screen UV → genuine glass-like distortion of the background.

      var cubeScene = new THREE.Scene();

      var geo = new THREE.BoxGeometry(2, 2, 2);

      var glassUniforms = {
        tBg:        { value: bgRT.texture },
        resolution: { value: new THREE.Vector2(rtW, rtH) },
        distortion: { value: 0.18 }
      };

      var glassMat = new THREE.ShaderMaterial({
        uniforms:    glassUniforms,
        transparent: true,
        side:        THREE.FrontSide,
        depthWrite:  false,
        vertexShader: [
          'varying vec3 vNormal;',
          'varying vec3 vViewDir;',
          'void main() {',
          '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
          '  vNormal  = normalize(normalMatrix * normal);',
          '  vViewDir = normalize(mv.xyz);',
          '  gl_Position = projectionMatrix * mv;',
          '}'
        ].join('\n'),
        fragmentShader: [
          'uniform sampler2D tBg;',
          'uniform vec2      resolution;',
          'uniform float     distortion;',
          'varying vec3 vNormal;',
          'varying vec3 vViewDir;',
          'void main() {',
          '  vec3 N = normalize(vNormal);',
          '  vec3 I = normalize(vViewDir);',
          // Fresnel — Schlick, glass F0 = 0.04
          '  float cosA = max(dot(-I, N), 0.0);',
          '  float fresnel = 0.04 + 0.96 * pow(1.0 - cosA, 5.0);',
          // Chromatic dispersion: 3 slightly different IOR per wavelength
          '  vec3 rR = refract(I, N, 1.0/1.56);',
          '  vec3 rG = refract(I, N, 1.0/1.60);',
          '  vec3 rB = refract(I, N, 1.0/1.64);',
          '  vec2 uv = gl_FragCoord.xy / resolution;',
          '  uv.y = 1.0 - uv.y;',
          '  float r = texture2D(tBg, clamp(uv + rR.xy * distortion, 0.001, 0.999)).r;',
          '  float g = texture2D(tBg, clamp(uv + rG.xy * distortion, 0.001, 0.999)).g;',
          '  float b = texture2D(tBg, clamp(uv + rB.xy * distortion, 0.001, 0.999)).b;',
          // Refracted image with subtle cold/blue tint (glass absorbs red slightly)
          '  vec3 refracted = vec3(r * 0.88, g * 0.93, b);',
          // Fresnel edge: bright blue-white specular
          '  vec3 col = mix(refracted, vec3(0.88, 0.94, 1.0), fresnel * 0.65);',
          // 15% visible at center so glass faces are readable, 95% at grazing edge
          '  float alpha = 0.15 + fresnel * 0.80;',
          '  gl_FragColor = vec4(col, alpha);',
          '}'
        ].join('\n')
      });

      var cube = new THREE.Mesh(geo, glassMat);
      cubeScene.add(cube);

      // White chrome edges — main visual identity of the cube
      cubeScene.add(new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92 })
      ));

      var glassRT = new THREE.WebGLRenderTarget(rtW, rtH, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat, stencilBuffer: false
      });

      // ── PASS 3: chromatic aberration → screen ─────────────────────────────
      var caOrtho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      var caScene = new THREE.Scene();
      var caMat   = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: glassRT.texture },
          amount:   { value: 0.012 }
        },
        transparent: true,
        depthTest:   false,
        depthWrite:  false,
        vertexShader: [
          'varying vec2 vUv;',
          'void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }'
        ].join('\n'),
        fragmentShader: [
          'uniform sampler2D tDiffuse;',
          'uniform float amount;',
          'varying vec2 vUv;',
          'void main(){',
          '  vec2 d = (vUv - 0.5) * amount;',
          '  float r  = texture2D(tDiffuse, vUv + d).r;',
          '  float gr = texture2D(tDiffuse, vUv    ).g;',
          '  float b  = texture2D(tDiffuse, vUv - d).b;',
          '  float a  = texture2D(tDiffuse, vUv    ).a;',
          '  gl_FragColor = vec4(r, gr, b, a);',
          '}'
        ].join('\n')
      });
      caScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), caMat));

      // ── Mouse ─────────────────────────────────────────────────────────────
      var mx = 0, my = 0;
      document.addEventListener('mousemove', function (e) {
        mx = (e.clientX / window.innerWidth)  * 2 - 1;
        my = -((e.clientY / window.innerHeight) * 2 - 1);
      }, { passive: true });

      // ── Animation loop ────────────────────────────────────────────────────
      var raf, t = 0, rx = 0, ry = 0;
      function animate() {
        raf = requestAnimationFrame(animate);
        t += 0.006;

        rx += (my * 0.45 - rx) * 0.04;
        ry += (mx * 0.45 - ry) * 0.04;
        cube.rotation.x = t * 0.22 + rx;
        cube.rotation.y = t * 0.37 + ry;

        caMat.uniforms.amount.value = 0.008 + Math.abs(Math.sin(t * 0.8)) * 0.012;

        // Pass 1 — background → bgRT
        renderer.setRenderTarget(bgRT);
        renderer.clear();
        renderer.render(bgScene, camera);

        // Pass 2 — glass cube (samples bgRT) → glassRT
        renderer.setRenderTarget(glassRT);
        renderer.clear();
        renderer.render(cubeScene, camera);

        // Pass 3 — CA quad → canvas (alpha preserved)
        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.render(caScene, caOrtho);
      }
      animate();

      // ── Resize ────────────────────────────────────────────────────────────
      window.addEventListener('resize', function () {
        var nW = wrap.offsetWidth  || W;
        var nH = wrap.offsetHeight || H;
        camera.aspect = nW / nH;
        camera.updateProjectionMatrix();
        renderer.setSize(nW, nH);
        var nRtW = Math.max(1, Math.round(nW * DPR));
        var nRtH = Math.max(1, Math.round(nH * DPR));
        bgRT.setSize(nRtW, nRtH);
        glassRT.setSize(nRtW, nRtH);
        glassUniforms.resolution.value.set(nRtW, nRtH);
        bgPlane.geometry.dispose();
        bgPlane.geometry = frustumPlane(nW, nH);
        if (heroTex) coverUV(heroTex, nW, nH);
      }, { passive: true });

      // ── Cleanup ───────────────────────────────────────────────────────────
      window.addEventListener('beforeunload', function () {
        cancelAnimationFrame(raf);
        renderer.dispose();
        bgRT.dispose();
        glassRT.dispose();
        geo.dispose();
        glassMat.dispose();
      });
    });
  }
})();
