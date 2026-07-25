// ╔══════════════════════════════════════════════════════════════════╗
// ║ projector-depth-renderer.js                                     ║
// ║ Tiny WebGL 2.5D renderer for Projector Focus Mode depth sidecars ║
// ║ v3: Dual-mode — orthographic parallax + perspective pinhole      ║
// ║     camera with SSAO (Screen-Space Ambient Occlusion)            ║
// ╚══════════════════════════════════════════════════════════════════╝
(function () {
    'use strict';

    // ════════════════════════════════════════════════════════════════
    //  SHADER UTILITIES
    // ════════════════════════════════════════════════════════════════

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

    // ════════════════════════════════════════════════════════════════
    //  SHADER SOURCES — DUAL-MODE (ortho + perspective pinhole camera)
    // ════════════════════════════════════════════════════════════════

    function shaderSources(webgl2) {

        // ── Vertex shader (identical for both modes) ──
        const vertexSrcWebGL2 = `#version 300 es
            in vec2 a_pos;
            out vec2 v_uv;
            void main() {
                v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
                gl_Position = vec4(a_pos, 0.0, 1.0);
            }
        `;
        const vertexSrcWebGL1 = `
            attribute vec2 a_pos;
            varying vec2 v_uv;
            void main() {
                v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
                gl_Position = vec4(a_pos, 0.0, 1.0);
            }
        `;

        // ── Fragment shaders ──
        // Shared logic appendix — appended to both paths to avoid duplication
        const FRAGMENT_COMMON_ORTHO = `
            // ── ORTHOGRAPHIC PARALLAX MODE (original behaviour) ──
            const int RAYS_ORTHO = 40;

            vec2 clampUv(vec2 uv) {
                return clamp(uv, vec2(0.001), vec2(0.999));
            }

            vec2 orthoRaymarch() {
                vec2 baseUv = u_uvOrigin + v_uv * u_uvSize;
                vec2 maxOffset = u_parallax * u_strength * u_uvSize;
                vec2 safeOffset = maxOffset;

                float stepT = 1.0 / float(RAYS_ORTHO);
                float rayT = 0.0;
                vec2 hitUv = baseUv;
                float lastSurfaceHeight = 1.0;
                float lastRayT = 0.0;

                for (int i = 0; i < RAYS_ORTHO; i++) {
                    vec2 currentUv = clampUv(baseUv + safeOffset * (u_pivot - (1.0 - rayT)));
                    float depthSample = TEXTURE_FN(u_depth, currentUv).r;
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
                return hitUv;
            }
        `;

        const FRAGMENT_COMMON_PERSPECTIVE = `
            // ── PERSPECTIVE PINHOLE CAMERA MODE ──
            const int RAYS_PERSP = 48;

            // AO constants
            const int AO_SAMPLES = 8;
            const float AO_GOLDEN_ANGLE = 2.399963; // radians

            // Transform screen UV → NDC with aspect ratio
            vec2 screenToNdc(vec2 uv) {
                return (uv - 0.5) * vec2(u_aspect, 1.0) * 2.0;
            }

            // NDC → world XY on the screen plane (Z=0)
            vec2 ndcToWorldAtScreen(vec2 ndc) {
                return ndc * u_cameraPos.z;
            }

            vec3 perspectiveRaymarch() {
                // Build the ray
                vec2 ndc = screenToNdc(v_uv);
                vec3 screenPoint = vec3(ndcToWorldAtScreen(ndc), 0.0);
                vec3 rayDir = normalize(screenPoint - u_cameraPos);

                float tMax = -u_cameraPos.z / rayDir.z;
                float stepSize = tMax / float(RAYS_PERSP);

                float t = 0.0;
                float lastT = 0.0;
                float lastSurfZ = 0.0;
                vec3 hitPoint = screenPoint;
                bool didHit = false;

                for (int i = 0; i < RAYS_PERSP; i++) {
                    vec3 p = u_cameraPos + rayDir * t;
                    vec2 sampleUv = clamp(p.xy + 0.5, vec2(0.001), vec2(0.999));
                    float d = TEXTURE_FN(u_depth, sampleUv).r;
                    if (u_invertDepth > 0.5) d = 1.0 - d;
                    float surfaceZ = d * u_maxDepth;

                    if (p.z <= surfaceZ) {
                        // Interpolate for exact intersection
                        float prevRayZ = u_cameraPos.z + rayDir.z * lastT;
                        float currRayZ = p.z;
                        float deltaRayZ  = currRayZ - prevRayZ;
                        float deltaSurfZ = surfaceZ - lastSurfZ;
                        float denom = deltaRayZ - deltaSurfZ;
                        float frac = abs(denom) > 0.00001
                            ? clamp((prevRayZ - lastSurfZ) / denom, 0.0, 1.0)
                            : 0.0;
                        hitPoint = mix(u_cameraPos + rayDir * lastT, p, frac);
                        didHit = true;
                        break;
                    }

                    lastSurfZ = surfaceZ;
                    lastT = t;
                    t += stepSize;
                }

                // Fallback: if no hit, use screen point
                if (!didHit) {
                    hitPoint = screenPoint;
                }

                return hitPoint;
            }

            float computeSSAO(vec2 centerUv, float centerDepth) {
                if (u_aoStrength <= 0.0) return 1.0;

                float aoAccum = 0.0;
                float contribCount = 0.0;

                for (int j = 0; j < AO_SAMPLES; j++) {
                    float angle = float(j) * AO_GOLDEN_ANGLE;
                    float radius = (float(j) + 0.5) / float(AO_SAMPLES) * u_aoRadius;
                    vec2 offset = vec2(cos(angle), sin(angle)) * radius;
                    vec2 sampleUv = clamp(centerUv + offset, vec2(0.0), vec2(1.0));

                    float neighborDepth = TEXTURE_FN(u_depth, sampleUv).r;
                    if (u_invertDepth > 0.5) neighborDepth = 1.0 - neighborDepth;

                    float depthDiff = neighborDepth - centerDepth;

                    // Depth threshold: skip disconnected surfaces.
                    // If the depth gap exceeds u_aoDepthThreshold, the surfaces
                    // are not in contact — no AO bleeding from far objects.
                    if (abs(depthDiff) < u_aoDepthThreshold) {
                        // Neighbor closer to camera → potential occluder
                        float occlusion = max(0.0, depthDiff) / u_aoDepthThreshold;
                        aoAccum += occlusion;
                        contribCount += 1.0;
                    }
                }

                if (contribCount < 0.5) return 1.0;

                float ao = 1.0 - (aoAccum / contribCount) * u_aoStrength;
                return clamp(ao, 0.0, 1.0);
            }
        `;

        const FRAGMENT_MAIN_BODY = `
            vec2 hitUv;
            float centerDepth;

            // ── Choose rendering path ──
            if (u_perspective < 0.01) {
                // Pure orthographic
                hitUv = orthoRaymarch();
                centerDepth = TEXTURE_FN(u_depth, hitUv).r;
                if (u_invertDepth > 0.5) centerDepth = 1.0 - centerDepth;
            } else if (u_perspective > 0.99) {
                // Pure perspective
                vec3 hp = perspectiveRaymarch();
                hitUv = clamp(hp.xy + 0.5, vec2(0.0), vec2(1.0));
                centerDepth = TEXTURE_FN(u_depth, hitUv).r;
                if (u_invertDepth > 0.5) centerDepth = 1.0 - centerDepth;
            } else {
                // Smooth blend for A/B calibration
                vec2 orthoUv = orthoRaymarch();
                vec3 hp = perspectiveRaymarch();
                vec2 perspUv = clamp(hp.xy + 0.5, vec2(0.0), vec2(1.0));
                hitUv = mix(orthoUv, perspUv, u_perspective);
                centerDepth = TEXTURE_FN(u_depth, hitUv).r;
                if (u_invertDepth > 0.5) centerDepth = 1.0 - centerDepth;
            }

            // ── Colour fetch ──
            OUT_COLOR = TEXTURE_FN(u_image, hitUv);

            // ── SSAO (perspective mode only) ──
            if (u_perspective > 0.01 && u_aoStrength > 0.0) {
                float ao = computeSSAO(hitUv, centerDepth);
                OUT_COLOR.rgb *= ao;
            }

            // ── Vignette ──
            if (u_vignette > 0.0) {
                vec2 d = v_uv - vec2(0.5);
                float vig = dot(d, d) * 1.5;
                float vignetteFactor = clamp(1.0 - vig * u_vignette, 0.0, 1.0);
                OUT_COLOR.rgb *= vignetteFactor;
            }
        `;

        // ── Assemble WebGL2 fragment ──
        const fragWebGL2 =
            `#version 300 es
            precision highp float;
            in vec2 v_uv;
            out vec4 fragColor;

            #define TEXTURE_FN texture
            #define OUT_COLOR fragColor

            uniform sampler2D u_image;
            uniform sampler2D u_depth;

            // ── Ortho uniforms ──
            uniform vec2 u_uvOrigin;
            uniform vec2 u_uvSize;
            uniform vec2 u_parallax;

            // ── Perspective uniforms ──
            uniform vec3  u_cameraPos;
            uniform float u_maxDepth;
            uniform float u_aspect;

            // ── SSAO uniforms ──
            uniform float u_aoStrength;
            uniform float u_aoRadius;
            uniform float u_aoDepthThreshold;

            // ── Shared uniforms ──
            uniform float u_strength;
            uniform float u_invertDepth;
            uniform float u_pivot;
            uniform float u_vignette;
            uniform float u_perspective;

            ` +
            FRAGMENT_COMMON_ORTHO +
            FRAGMENT_COMMON_PERSPECTIVE +
            `void main() {` + FRAGMENT_MAIN_BODY + `}`;

        // ── Assemble WebGL1 fragment ──
        const fragWebGL1 =
            `
            precision highp float;
            varying vec2 v_uv;

            #define TEXTURE_FN texture2D
            #define OUT_COLOR gl_FragColor

            uniform sampler2D u_image;
            uniform sampler2D u_depth;
            uniform vec2 u_uvOrigin;
            uniform vec2 u_uvSize;
            uniform vec2 u_parallax;
            uniform vec3  u_cameraPos;
            uniform float u_maxDepth;
            uniform float u_aspect;
            uniform float u_aoStrength;
            uniform float u_aoRadius;
            uniform float u_aoDepthThreshold;
            uniform float u_strength;
            uniform float u_invertDepth;
            uniform float u_pivot;
            uniform float u_vignette;
            uniform float u_perspective;

            ` +
            FRAGMENT_COMMON_ORTHO +
            FRAGMENT_COMMON_PERSPECTIVE +
            `void main() {` + FRAGMENT_MAIN_BODY + `}`;

        if (webgl2) {
            return { vertex: vertexSrcWebGL2, fragment: fragWebGL2 };
        }
        return { vertex: vertexSrcWebGL1, fragment: fragWebGL1 };
    }

    // ════════════════════════════════════════════════════════════════
    //  VPDepthRenderer
    // ════════════════════════════════════════════════════════════════

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
                pos:   gl.getAttribLocation(this.program, 'a_pos'),
                image: gl.getUniformLocation(this.program, 'u_image'),
                depth: gl.getUniformLocation(this.program, 'u_depth'),

                // Ortho
                uvOrigin:    gl.getUniformLocation(this.program, 'u_uvOrigin'),
                uvSize:      gl.getUniformLocation(this.program, 'u_uvSize'),
                parallax:    gl.getUniformLocation(this.program, 'u_parallax'),

                // Perspective
                cameraPos:   gl.getUniformLocation(this.program, 'u_cameraPos'),
                maxDepth:    gl.getUniformLocation(this.program, 'u_maxDepth'),
                aspect:      gl.getUniformLocation(this.program, 'u_aspect'),

                // SSAO
                aoStrength:       gl.getUniformLocation(this.program, 'u_aoStrength'),
                aoRadius:         gl.getUniformLocation(this.program, 'u_aoRadius'),
                aoDepthThreshold: gl.getUniformLocation(this.program, 'u_aoDepthThreshold'),

                // Shared
                strength:    gl.getUniformLocation(this.program, 'u_strength'),
                invertDepth: gl.getUniformLocation(this.program, 'u_invertDepth'),
                pivot:       gl.getUniformLocation(this.program, 'u_pivot'),
                vignette:    gl.getUniformLocation(this.program, 'u_vignette'),
                perspective: gl.getUniformLocation(this.program, 'u_perspective'),
            };

            this.imageTex = null;
            this.depthTex = null;
            this.imageSize = { width: 1, height: 1 };
            this.depthSize = { width: 1, height: 1 };
            this.imageSrc = '';
            this.depthSrc = '';
            this.ready = false;

            // Cached camera params for getDepthAt
            this._lastCamera = null;
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

        // ════════════════════════════════════════════════════════════
        //  computeUv — ortho crop window (unchanged, backward compat)
        // ════════════════════════════════════════════════════════════

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
                size:   [viewW / srcW, viewH / srcH],
            };
        }

        // ════════════════════════════════════════════════════════════
        //  computeCamera — physical pinhole camera from viewport params
        // ════════════════════════════════════════════════════════════

        computeCamera(viewport = {}, options = {}) {
            const zoom = Math.max(1, Number(viewport.zoom) || 1);
            const x    = Math.max(0, Math.min(1, viewport.x != null ? Number(viewport.x) : 0.5));
            const y    = Math.max(0, Math.min(1, viewport.y != null ? Number(viewport.y) : 0.5));

            // baseDistance = 0.5: при zoom=1 изображение целиком заполняет экран
            // camZ уменьшается при zoom-in — камера приближается
            const baseDistance = 0.5;
            const camZ = baseDistance / zoom;

            // panRange: при zoom=1 = 0 (нет панорамирования — картинка ровно по размеру)
            //           при zoom=1.5 = 0.17 (ровно до краёв изображения)
            // Формула выведена из геометрии: half-visible = camZ, image half-size = 0.5
            const panRange = 0.5 - camZ;   // = 0.5 * (1 - 1/zoom)
            const camX = (x - 0.5) * 2.0 * panRange;
            const camY = (y - 0.5) * 2.0 * panRange;

            // maxDepth — амплитуда рельефа: strength * strengthMultiplier
            const baseMaxDepth = 0.25;
            const strengthMul = Number(options.strengthMultiplier) || 1.0;
            const rawStrength = options.strength != null ? Number(options.strength) : 0.055;
            const maxDepth = baseMaxDepth * rawStrength / 0.055 * strengthMul;

            const aspect = this.canvas.width / (this.canvas.height || 1);

            const cam = {
                cameraPos: [camX, camY, camZ],
                maxDepth,
                aspect,
            };

            this._lastCamera = cam;
            return cam;
        }

        // ════════════════════════════════════════════════════════════
        //  render — dual-mode ortho | perspective | blend
        // ════════════════════════════════════════════════════════════

        render(viewport = {}, options = {}) {
            if (!this.ready || !this.imageTex || !this.depthTex) return false;
            this.resize();
            const gl = this.gl;

            // ── Read options ──
            const perspective = options.perspective != null
                ? Math.max(0, Math.min(1, Number(options.perspective)))
                : 1.0;   // default: perspective mode on

            const strength = Math.max(0, Math.min(0.2, Number(options.strength) || 0.055));
            const invertDepth = options.inverted ? 1 : 0;
            const pivot = options.pivot != null ? Math.max(0, Math.min(1, Number(options.pivot))) : 1.0;
            const vignette = options.vignette != null ? Math.max(0, Math.min(1, Number(options.vignette))) : 0.0;

            // AO params — defaults tuned for desktop
            const aoStrength = options.aoStrength != null
                ? Math.max(0, Math.min(1, Number(options.aoStrength)))
                : 0.35;
            const aoRadius = options.aoRadius != null
                ? Math.max(0.005, Math.min(0.08, Number(options.aoRadius)))
                : 0.018;
            const aoDepthThreshold = options.aoDepthThreshold != null
                ? Math.max(0.02, Math.min(0.5, Number(options.aoDepthThreshold)))
                : 0.12;

            // ── Compute both paths ──
            const uv = this.computeUv(viewport);
            const x = Math.max(0, Math.min(1, viewport.x != null ? Number(viewport.x) : 0.5));
            const y = Math.max(0, Math.min(1, viewport.y != null ? Number(viewport.y) : 0.5));
            const parallax = [(x - 0.5) * 2.0, (y - 0.5) * 2.0];

            const cam = this.computeCamera(viewport, options);

            // ── Bind program ──
            gl.useProgram(this.program);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
            gl.enableVertexAttribArray(this.loc.pos);
            gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0);

            // Textures
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
            gl.uniform1i(this.loc.image, 0);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
            gl.uniform1i(this.loc.depth, 1);

            // ── Ortho uniforms ──
            gl.uniform2f(this.loc.uvOrigin, uv.origin[0], uv.origin[1]);
            gl.uniform2f(this.loc.uvSize,   uv.size[0],   uv.size[1]);
            gl.uniform2f(this.loc.parallax, parallax[0],   parallax[1]);

            // ── Perspective uniforms ──
            gl.uniform3f(this.loc.cameraPos, cam.cameraPos[0], cam.cameraPos[1], cam.cameraPos[2]);
            gl.uniform1f(this.loc.maxDepth,  cam.maxDepth);
            gl.uniform1f(this.loc.aspect,    cam.aspect);

            // ── SSAO uniforms ──
            gl.uniform1f(this.loc.aoStrength,       aoStrength);
            gl.uniform1f(this.loc.aoRadius,          aoRadius);
            gl.uniform1f(this.loc.aoDepthThreshold,  aoDepthThreshold);

            // ── Shared uniforms ──
            gl.uniform1f(this.loc.strength,    strength);
            gl.uniform1f(this.loc.invertDepth, invertDepth);
            gl.uniform1f(this.loc.pivot,       pivot);
            gl.uniform1f(this.loc.vignette,    vignette);
            gl.uniform1f(this.loc.perspective, perspective);

            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            return true;
        }

        // ════════════════════════════════════════════════════════════
        //  getDepthAt — return depth value at world UV
        //  (used for Focal Lock click-to-set-focus-plane)
        // ════════════════════════════════════════════════════════════

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

        // ════════════════════════════════════════════════════════════
        //  getDepthAtWorld — world-space depth (for perspective mode)
        //  Returns depth * maxDepth so focal lock works in metres
        // ════════════════════════════════════════════════════════════

        getDepthAtWorld(uvX, uvY, maxDepth) {
            const raw = this.getDepthAt(uvX, uvY);
            return raw * (maxDepth || 0.25);
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
