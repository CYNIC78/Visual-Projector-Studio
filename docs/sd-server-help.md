# sd-server.exe — Reference (leejet/stable-diffusion.cpp)

> Build: `cc73429` (week-old as of 2026-07-13)
> Binary: `bin/sd.cpp/sd-server.exe`

## Launch

```bash
sd-server.exe -m <model> --listen-port <port> [context-options...]
```

## Server Options

| Flag | Description |
|------|-------------|
| `-l, --listen-ip <string>` | server listen ip (default: 127.0.0.1) |
| `--serve-html-path <string>` | path to HTML file to serve at root (optional) |
| `--listen-port <int>` | server listen port (default: 1234) |
| `-v, --verbose` | print extra info |
| `--color` | colors the logging tags according to level |
| `-h, --help` | show this help message and exit |

## Context Options (model loading)

| Flag | Description |
|------|-------------|
| `-m, --model <string>` | path to full model |
| `--clip_l <string>` | path to the clip-l text encoder |
| `--clip_g <string>` | path to the clip-g text encoder |
| `--clip_vision <string>` | path to the clip-vision encoder |
| `--t5xxl <string>` | path to the t5xxl text encoder |
| `--llm <string>` | path to the llm text encoder |
| `--diffusion-model <string>` | path to the standalone diffusion model |
| `--vae <string>` | path to standalone vae model |
| `--vae-format <string>` | VAE latent format override: auto, flux, sd3, or flux2 (default: auto) |
| `--taesd <string>` | path to taesd. Using Tiny AutoEncoder for fast decoding (low quality) |
| `--control-net <string>` | path to control net model |
| `--embd-dir <string>` | embeddings directory |
| `--lora-model-dir <string>` | lora model directory |
| `--hires-upscalers-dir <string>` | highres fix upscaler model directory |
| `--backend <string>` | runtime backend assignment, e.g. cpu or clip=cpu,vae=cuda0,diffusion=vulkan0 |
| `--params-backend <string>` | parameter backend assignment |
| `--split-mode <string>` | weight distribution for modules assigned multiple devices |
| `--rpc-servers <string>` | comma-separated list of RPC servers to connect to for offloading |
| `--max-vram <string>` | maximum VRAM budget in GiB for graph-cut segmented execution |
| `-t, --threads <int>` | number of threads to use during computation (default: -1) |
| `--stream-layers` | enable residency+prefetch streaming on top of --max-vram |
| `--eager-load` | load all params into the params backend at model-load time |
| `--auto-fit` | pick device placements automatically from the model size and memory budgets |
| `--offload-to-cpu` | place the weights in RAM to save VRAM |
| `--mmap` | whether to memory-map model |
| `--fa` | use flash attention |
| `--diffusion-fa` | use flash attention in the diffusion model only |
| `--type` | weight type (f32, f16, q4_0, q4_1, q5_0, q5_1, q8_0, q2_K, q3_K, q4_K) |
| `--rng` | RNG, one of [std_default, cuda, cpu] |
| `--sampler-rng` | sampler RNG, one of [std_default, cuda, cpu] |
| `--prediction` | prediction type override |
| `--lora-apply-mode` | the way to apply LoRA: auto, immediately, at_runtime |
| `--list-devices` | list available ggml backend devices and exit |

## Default Generation Options

| Flag | Description |
|------|-------------|
| `-p, --prompt <string>` | the prompt to render |
| `-n, --negative-prompt <string>` | the negative prompt (default: "") |
| `-i, --init-img <string>` | path to the init image |
| `--mask <string>` | path to the mask image |
| `--control-image <string>` | path to control image, control net |
| `--hires-upscaler <string>` | highres fix upscaler |
| `-H, --height <int>` | image height, in pixel space (default: 512) |
| `-W, --width <int>` | image width, in pixel space (default: 512) |
| `--steps <int>` | number of sample steps (default: 20) |
| `--high-noise-steps <int>` | (high noise) number of sample steps (default: -1 = auto) |
| `--clip-skip <int>` | ignore last layers of CLIP network (default: -1) |
| `-b, --batch-count <int>` | batch count |
| `--video-frames <int>` | video frames (default: 1) |
| `--fps <int>` | fps (default: 24) |
| `--upscale-repeats <int>` | Run the ESRGAN upscaler this many times (default: 1) |
| `--upscale-tile-size <int>` | tile size for ESRGAN upscaling (default: 128) |
| `--hires-width <int>` | highres fix target width (default: 0) |
| `--hires-height <int>` | highres fix target height (default: 0) |
| `--hires-steps <int>` | highres fix second pass sample steps (default: 0) |
| `--cfg-scale <float>` | unconditional guidance scale (default: 7.0) |
| `--img-cfg-scale <float>` | image guidance scale for inpaint or image edit models |
| `--guidance <float>` | distilled guidance scale for models with guidance input (default: 3.5) |
| `--slg-scale <float>` | skip layer guidance (SLG) scale, only for DiT models (default: 0) |
| `--skip-layer-start <float>` | SLG enabling point (default: 0.01) |
| `--skip-layer-end <float>` | SLG disabling point (default: 0.2) |
| `--eta <float>` | noise multiplier |
| `--flow-shift <float>` | shift value for Flow models like SD3.x or WAN (default: auto) |
| `--strength <float>` | strength for noising/unnoising (default: 0.75) |
| `--control-strength <float>` | strength to apply Control Net (default: 0.9) |
| `--vae-tile-overlap <float>` | tile overlap for vae tiling, in fraction of tile size (default: 0.5) |
| `--hires-scale <float>` | highres fix scale when target size is not set (default: 2.0) |
| `--hires-denoising-strength <float>` | highres fix second pass denoising strength (default: 0.7) |
| `--increase-ref-index` | automatically increase the indices of references images |
| `--disable-auto-resize-ref-image` | disable auto resize of ref images |
| `--circular` | enable circular padding on both axes for tileable output |
| `--vae-tiling` | process vae in tiles to reduce memory usage |
| `--temporal-tiling` | enable temporal tiling for LTX video VAE decode |
| `--hires` | enable highres fix |
| `-s, --seed` | RNG seed (default: 42, use random seed for < 0) |
| `--sampling-method` | sampling method (default: euler for Flux/SD3/Wan, euler_a otherwise) |
| `--high-noise-sampling-method` | (high noise) sampling method |
| `--scheduler` | denoiser sigma scheduler (default: model-specific) |
| `--sigmas` | custom sigma values for the sampler, comma-separated |
| `--hires-sigmas` | custom sigma values for the highres fix second pass |
| `--skip-layers` | layers to skip for SLG steps (default: [7,8,9]) |
| `--cache-mode` | caching method: easycache, ucache, dbcache, taylorseer, spectrum |
| `--vae-tile-size` | tile size for vae tiling, format [X]x[Y] (default: 32x32) |
| `--vae-relative-tile-size` | relative tile size for vae tiling |
| `--prompt-file` | path to the file containing the prompt |
| `--negative-prompt-file` | path to the file containing the negative prompt |

## Reference Images

| Flag | Description |
|------|-------------|
| `-r, --ref-image` | reference image for Flux Kontext models (can be used multiple times) |

## Notes for VP Studio Integration

- **No temp files needed.** Unlike CLI, server keeps the model in VRAM and accepts generation params via HTTP.
- **HTTP API families** exposed by this server (see upstream `examples/server/api.md`):
  - `POST /sdapi/v1/txt2img` — AUTOMATIC1111 compatible (synchronous)
  - `POST /v1/images/generations` — OpenAI compatible
  - `POST /sdcpp/v1/img_gen` — native async with job polling
  - `GET /sdapi/v1/options` — server status / loaded model info
- **Port:** default `1234`. VP Studio should pick a random free port to avoid conflicts.
- **Model loading:** happens once at startup via `-m` or `--diffusion-model` + text encoders. Changing the model requires restarting the server process.
- **LoRA:** server accepts `--lora-model-dir` at startup. Individual LoRAs are applied via API fields (not CLI flags during generation).
