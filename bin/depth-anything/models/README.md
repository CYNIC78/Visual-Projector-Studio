# Depth Anything GGUF models

Put depth-anything.cpp GGUF models here.

Upstream model page:

https://huggingface.co/mudler/depth-anything.cpp-gguf

Suggested first target for VP Studio experiments: a small/base quantized model, CPU-friendly.

Example future layout:

```text
bin/depth-anything/models/depth-anything-...q4_k.gguf
```


## Known working model

The first model confirmed to work with our locally built `da3-cli.exe`:

```text
depth-anything-base-q8_0.gguf
```

Place it here:

```text
bin/depth-anything/models/depth-anything-base-q8_0.gguf
```
