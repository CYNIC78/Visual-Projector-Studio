// ╔══════════════════════════════════════════════════════════════════╗
//  projector-depth-renderer.js                                     ║
//  Tiny WebGL 2.5D renderer for Projector Focus Mode depth sidecars ║
//  v3.1: Fixed perspective projection (strength in numerator only)  ║
// ╚══════════════════════════════════════════════════════════════════╝
(function () {
'use strict';
function createShader(gl, type, source) {
     const shader = gl.createShader(type);
     gl.shaderSource(shader, source);
     gl.compileShader(shader);
     if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
         const log = gl.getShaderInfoLog(shader) || 'unknown shader error';
         gl.deleteShader(shader);
         throw new Error(log);
     }
     return shader;
 }
 function createProgram(gl, vertexSource, fragmentSource) {
     const vs = createShader(gl, gl.VERTEX_SHADER, vertexSource);
     const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
     const program = gl.createProgram();
     gl.attachShader(program, vs);
     gl.attachShader(program, fs);
     gl.linkProgram(program);
     gl.deleteShader(vs);
     gl.deleteShader(fs);
     if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
         const log = gl.getProgramInfoLog(program) || 'unknown program link error';
         gl.deleteProgram(program);
         throw new Error(log);
     }
     return program;
 }
 function createTexture(gl, image) {
     const tex = gl.createTexture();
     gl.bindTexture(gl.TEXTURE_2D, tex);
     gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
     gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
     gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
     gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
     gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
     gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
     gl.bindTexture(gl.TEXTURE_2D, null);
     return tex;
 }
 function loadImage(src) {
     return new Promise((resolve, reject) => {
         const img = new Image();
         img.onload = () => resolve(img);
         img.onerror = () => reject(new Error('Image load failed: ' + String(src || '').slice(0, 120)));
         img.src = src;
     });
 }
 function shaderSources(webgl2) {
     if (webgl2) {
         return {
             vertex: `#version 300 es
                 in vec2 a_pos;
                 out vec2 v_uv;
                 void main() {
                     v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
                     gl_Position = vec4(a_pos, 0.0, 1.0);
                 }
             `,
             fragment: `#version 300 es
                 precision highp float;
                 in vec2 v_uv;
                 out vec4 fragColor;
                 uniform sampler2D u_image;
                 uniform sampler2D u_depth;
                 uniform vec2 u_uvOrigin;
                 uniform vec2 u_uvSize;
                 uniform vec2 u_parallax;
                 uniform float u_strength;
                 uniform float u_invertDepth;
                 uniform float u_pivot;
                 uniform float u_vignette;
                 uniform vec2 u_camUV;
                 uniform float u_camDist;
                 uniform float u_dofStrength;
                 uniform float u_aberration;
                 const int RAYS_MIN = 32;
                 const int RAYS_MAX = 64;
                 vec2 clampUv(vec2 uv) {
                     return clamp(uv, vec2(0.001), vec2(0.999));
                 }
                 void main() {
                     vec2 baseUv = u_uvOrigin + v_uv * u_uvSize;
                     
                     // Adaptive ray count
                     float parallaxIntensity = length(u_parallax);
                     int rays = int(mix(float(RAYS_MIN), float(RAYS_MAX), clamp(parallaxIntensity * 2.0, 0.0, 1.0)));
                     float stepT = 1.0 / float(rays);
                     
                     float rayT = 0.0;
                     vec2 hitUv = baseUv;
                     float hitDepth = 0.0;
                     float lastSurfaceHeight = 1.0;
                     float lastRayT = 0.0;
                     
                     // Perspective raymarching
                     for (int i = 0; i < RAYS_MAX; i++) {
                         if (i >= rays) break;
                         
                         float d = 1.0 - rayT; // depth: 0=far, 1=near
                         
                         // CORRECTED perspective projection:
                         // Camera at camUV, distance camDist from scene
                         // Point at depth d projects with perspective factor
                         float perspectiveFactor = u_camDist / (u_camDist + d * u_strength);
                         vec2 projectedUv = u_camUV + (baseUv - u_camUV) * perspectiveFactor;
                         vec2 currentUv = clampUv(projectedUv);
                         
                         float depthSample = texture(u_depth, currentUv).r;
                         if (u_invertDepth > 0.5) depthSample = 1.0 - depthSample;
                         float currentSurfaceHeight = depthSample;
                         float currentRayHeight = 1.0 - rayT;
                         
                         if (currentRayHeight <= currentSurfaceHeight) {
                             // Bilinear interpolation
                             float prevRayHeight = 1.0 - lastRayT;
                             float denom = (depthSample - lastSurfaceHeight) - (currentRayHeight - prevRayHeight);
                             float t = abs(denom) > 0.00001
                                 ? (prevRayHeight - lastSurfaceHeight) / denom
                                 : 0.0;
                             rayT = mix(lastRayT, rayT, clamp(t, 0.0, 1.0));
                             
                             // Recalculate hit UV
                             float hitD = 1.0 - rayT;
                             float hitPerspFactor = u_camDist / (u_camDist + hitD * u_strength);
                             vec2 hitProjectedUv = u_camUV + (baseUv - u_camUV) * hitPerspFactor;
                             hitUv = clampUv(hitProjectedUv);
                             hitDepth = hitD;
                             break;
                         }
                         
                         lastRayT = rayT;
                         lastSurfaceHeight = depthSample;
                         rayT += stepT;
                     }
                     
                     // Depth of Field
                     vec4 color = texture(u_image, hitUv);
                     if (u_dofStrength > 0.001) {
                         float focalDepth = u_pivot;
                         float coc = abs(hitDepth - focalDepth) * u_dofStrength;
                         coc = smoothstep(0.0, 0.3, coc) * 0.015;
                         
                         if (coc > 0.0001) {
                             vec4 blurred = vec4(0.0);
                             float total = 0.0;
                             const int DOF_SAMPLES = 8;
                             for (int j = 0; j < DOF_SAMPLES; j++) {
                                 float angle = float(j) * 0.785398;
                                 vec2 offset = vec2(cos(angle), sin(angle)) * coc;
                                 blurred += texture(u_image, hitUv + offset);
                                 total += 1.0;
                             }
                             color = blurred / total;
                         }
                     }
                     
                     // Chromatic aberration
                     if (u_aberration > 0.001) {
                         vec2 dirFromCenter = hitUv - vec2(0.5);
                         float distFromCenter = length(dirFromCenter);
                         float aberrationAmount = distFromCenter * distFromCenter * u_aberration * 0.003;
                         
                         if (aberrationAmount > 0.0001) {
                             color.r = texture(u_image, hitUv + dirFromCenter * aberrationAmount).r;
                             color.b = texture(u_image, hitUv - dirFromCenter * aberrationAmount).b;
                         }
                     }
                     
                     // Vignette
                     if (u_vignette > 0.0) {
                         vec2 d = v_uv - vec2(0.5);
                         float vig = dot(d, d) * 1.5;
                         float vignetteFactor = clamp(1.0 - vig * u_vignette, 0.0, 1.0);
                         color.rgb *= vignetteFactor;
                     }
                     
                     fragColor = color;
                 }
             `,
         };
     }
     // WebGL1 fallback
     return {
         vertex: `
             attribute vec2 a_pos;
             varying vec2 v_uv;
             void main() {
                 v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
                 gl_Position = vec4(a_pos, 0.0, 1.0);
             }
         `,
         fragment: `
             precision highp float;
             varying vec2 v_uv;
             uniform sampler2D u_image;
             uniform sampler2D u_depth;
             uniform vec2 u_uvOrigin;
             uniform vec2 u_uvSize;
             uniform vec2 u_parallax;
             uniform float u_strength;
             uniform float u_invertDepth;
             uniform float u_pivot;
             uniform float u_vignette;
             const int RAYS = 40;
             vec2 clampUv(vec2 uv) {
                 return clamp(uv, vec2(0.001), vec2(0.999));
             }
             void main() {
                 vec2 baseUv = u_uvOrigin + v_uv * u_uvSize;
                 vec2 maxOffset = u_parallax * u_strength * u_uvSize;
                 vec2 safeOffset = maxOffset;
                 float stepT = 1.0 / float(RAYS);
                 float rayT = 0.0;
                 vec2 hitUv = baseUv;
                 float lastSurfaceHeight = 1.0;
                 float lastRayT = 0.0;
                 for (int i = 0; i < RAYS; i++) {
                     vec2 currentUv = clampUv(baseUv + safeOffset * (u_pivot - (1.0 - rayT)));
                     float depthSample = texture2D(u_depth, currentUv).r;
                     if (u_invertDepth > 0.5) depthSample = 1.0 - depthSample;
                     float currentSurfaceHeight = depthSample;
                     float currentRayHeight = 1.0 - rayT;
                     if (currentRayHeight <= currentSurfaceHeight) {
                         float prevRayHeight = 1.0 - lastRayT;
                         float denom = (depthSample - lastSurfaceHeight) - (currentRayHeight - prevRayHeight);
                         float t = abs(denom) > 0.00001
                             ? (prevRayHeight - lastSurfaceHeight) / denom
                             : 0.0;
                         rayT = mix(lastRayT, rayT, clamp(t, 0.0, 1.0));
                         hitUv = clampUv(baseUv + safeOffset * (u_pivot - (1.0 - rayT)));
                         break;
                     }
                     lastRayT = rayT;
                     lastSurfaceHeight = depthSample;
                     rayT += stepT;
                 }
                 gl_FragColor = texture2D(u_image, hitUv);
                 if (u_vignette > 0.0) {
                     vec2 d = v_uv - vec2(0.5);
                     float vig = dot(d, d) * 1.5;
                     float vignetteFactor = clamp(1.0 - vig * u_vignette, 0.0, 1.0);
                     gl_FragColor.rgb *= vignetteFactor;
                 }
             }
         `,
     };
 }

 class VPDepthRenderer {
     constructor(canvas) {
         this.canvas = canvas;
         this.gl = canvas.getContext('webgl2', {
             alpha: true,
             antialias: true,
             premultipliedAlpha: false,
             preserveDrawingBuffer: true,
         });
         this.webgl2 = !!this.gl;
         if (!this.gl) {
             this.gl = canvas.getContext('webgl', {
                 alpha: true,
                 antialias: true,
                 premultipliedAlpha: false,
                 preserveDrawingBuffer: true,
             }) || canvas.getContext('experimental-webgl');
         }
         if (!this.gl) throw new Error('WebGL is not available');
         const gl = this.gl;
         const sources = shaderSources(this.webgl2);
         this.program = createProgram(gl, sources.vertex, sources.fragment);
         this.buffer = gl.createBuffer();
         gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
         gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
             -1, -1,  1, -1, -1,  1,
             -1,  1,  1, -1,  1,  1,
         ]), gl.STATIC_DRAW);
         this.loc = {
             pos: gl.getAttribLocation(this.program, 'a_pos'),
             image: gl.getUniformLocation(this.program, 'u_image'),
             depth: gl.getUniformLocation(this.program, 'u_depth'),
             uvOrigin: gl.getUniformLocation(this.program, 'u_uvOrigin'),
             uvSize: gl.getUniformLocation(this.program, 'u_uvSize'),
             parallax: gl.getUniformLocation(this.program, 'u_parallax'),
             strength: gl.getUniformLocation(this.program, 'u_strength'),
             invertDepth: gl.getUniformLocation(this.program, 'u_invertDepth'),
             pivot: gl.getUniformLocation(this.program, 'u_pivot'),
             vignette: gl.getUniformLocation(this.program, 'u_vignette'),
         };
         if (this.webgl2) {
             this.loc.camUV = gl.getUniformLocation(this.program, 'u_camUV');
             this.loc.camDist = gl.getUniformLocation(this.program, 'u_camDist');
             this.loc.dofStrength = gl.getUniformLocation(this.program, 'u_dofStrength');
             this.loc.aberration = gl.getUniformLocation(this.program, 'u_aberration');
         }
         this.imageTex = null;
         this.depthTex = null;
         this.imageSize = { width: 1, height: 1 };
         this.depthSize = { width: 1, height: 1 };
         this.imageSrc = '';
         this.depthSrc = '';
         this.ready = false;
     }
     async setSources(imageSrc, depthSrc) {
         if (imageSrc === this.imageSrc && depthSrc === this.depthSrc && this.ready) return;
         const [img, depth] = await Promise.all([loadImage(imageSrc), loadImage(depthSrc)]);
         const gl = this.gl;
         if (this.imageTex) gl.deleteTexture(this.imageTex);
         if (this.depthTex) gl.deleteTexture(this.depthTex);
         this.imageTex = createTexture(gl, img);
         this.depthTex = createTexture(gl, depth);
         this.imageSize = { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
         this.depthSize = { width: depth.naturalWidth || depth.width, height: depth.naturalHeight || depth.height };
         this.depthImage = depth;
         this.imageSrc = imageSrc;
         this.depthSrc = depthSrc;
         this.ready = true;
     }
     resize() {
         const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
         const rect = this.canvas.getBoundingClientRect();
         const w = Math.max(2, Math.round(rect.width * dpr));
         const h = Math.max(2, Math.round(rect.height * dpr));
         if (this.canvas.width !== w || this.canvas.height !== h) {
             this.canvas.width = w;
             this.canvas.height = h;
         }
         this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
     }
     computeUv(viewport = {}) {
         const outW = this.canvas.width || 768;
         const outH = this.canvas.height || 576;
         const srcW = this.imageSize.width || 1;
         const srcH = this.imageSize.height || 1;
         const zoom = Math.max(1, Number(viewport.zoom) || 1);
         const x = Math.max(0, Math.min(1, viewport.x != null ? Number(viewport.x) : 0.5));
         const y = Math.max(0, Math.min(1, viewport.y != null ? Number(viewport.y) : 0.5));
         const scale = Math.max(outW / srcW, outH / srcH) * zoom;
         const viewW = Math.min(srcW, outW / scale);
         const viewH = Math.min(srcH, outH / scale);
         const sx = Math.max(0, Math.min(srcW - viewW, (srcW - viewW) * x));
         const sy = Math.max(0, Math.min(srcH - viewH, (srcH - viewH) * y));
         return {
             origin: [sx / srcW, sy / srcH],
             size: [viewW / srcW, viewH / srcH],
         };
     }
     render(viewport = {}, options = {}) {
         if (!this.ready || !this.imageTex || !this.depthTex) return false;
         this.resize();
         const gl = this.gl;
         const uv = this.computeUv(viewport);
         const x = Math.max(0, Math.min(1, viewport.x != null ? Number(viewport.x) : 0.5));
         const y = Math.max(0, Math.min(1, viewport.y != null ? Number(viewport.y) : 0.5));
         const parallax = [(x - 0.5) * 2.0, (y - 0.5) * 2.0];
         const strength = Math.max(0, Math.min(0.1, Number(options.strength) || 0.05));
         const invertDepth = options.inverted ? 1 : 0;
         const pivot = options.pivot != null ? Math.max(0, Math.min(1, Number(options.pivot))) : 1.0;
         const vignette = options.vignette != null ? Math.max(0, Math.min(1, Number(options.vignette))) : 0.0;
         
         // Perspective camera parameters
         const zoom = Math.max(1, Number(viewport.zoom) || 1);
         const camDist = Math.max(0.3, 1.5 - zoom * 0.4);
         const camUV = [0.5 - parallax[0] * 0.3, 0.5 - parallax[1] * 0.3];
         
         const dofStrength = options.dofStrength != null ? Math.max(0, Math.min(2, Number(options.dofStrength))) : 0.0;
         const aberration = options.aberration != null ? Math.max(0, Math.min(1, Number(options.aberration))) : 0.0;
         
         gl.useProgram(this.program);
         gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
         gl.enableVertexAttribArray(this.loc.pos);
         gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0);
         gl.activeTexture(gl.TEXTURE0);
         gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
         gl.uniform1i(this.loc.image, 0);
         gl.activeTexture(gl.TEXTURE1);
         gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
         gl.uniform1i(this.loc.depth, 1);
         gl.uniform2f(this.loc.uvOrigin, uv.origin[0], uv.origin[1]);
         gl.uniform2f(this.loc.uvSize, uv.size[0], uv.size[1]);
         gl.uniform2f(this.loc.parallax, parallax[0], parallax[1]);
         gl.uniform1f(this.loc.strength, strength);
         gl.uniform1f(this.loc.invertDepth, invertDepth);
         gl.uniform1f(this.loc.pivot, pivot);
         gl.uniform1f(this.loc.vignette, vignette);
         
         if (this.webgl2) {
             gl.uniform2f(this.loc.camUV, camUV[0], camUV[1]);
             gl.uniform1f(this.loc.camDist, camDist);
             gl.uniform1f(this.loc.dofStrength, dofStrength);
             gl.uniform1f(this.loc.aberration, aberration);
         }
         
         gl.clearColor(0, 0, 0, 0);
         gl.clear(gl.COLOR_BUFFER_BIT);
         gl.drawArrays(gl.TRIANGLES, 0, 6);
         return true;
     }
     getDepthAt(uvX, uvY) {
         if (!this.ready || !this.depthImage) return 1.0;
         try {
             if (!this.offscreenCanvas) {
                 this.offscreenCanvas = document.createElement('canvas');
                 this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });
             }
             const img = this.depthImage;
             const w = img.naturalWidth || img.width || 100;
             const h = img.naturalHeight || img.height || 100;
             if (this.offscreenCanvas.width !== w || this.offscreenCanvas.height !== h) {
                 this.offscreenCanvas.width = w;
                 this.offscreenCanvas.height = h;
                 this.offscreenCtx.drawImage(img, 0, 0, w, h);
             }
             const px = Math.max(0, Math.min(w - 1, Math.floor(uvX * w)));
             const py = Math.max(0, Math.min(h - 1, Math.floor(uvY * h)));
             const data = this.offscreenCtx.getImageData(px, py, 1, 1).data;
             return data[0] / 255.0;
         } catch (err) {
             console.warn('[VPDepthRenderer] Failed to get depth at UV:', err);
             return 1.0;
         }
     }
     dispose() {
         const gl = this.gl;
         if (this.imageTex) gl.deleteTexture(this.imageTex);
         if (this.depthTex) gl.deleteTexture(this.depthTex);
         if (this.buffer) gl.deleteBuffer(this.buffer);
         if (this.program) gl.deleteProgram(this.program);
         this.imageTex = null;
         this.depthTex = null;
         this.ready = false;
     }
 }
 window.VPDepthRenderer = VPDepthRenderer;
})();