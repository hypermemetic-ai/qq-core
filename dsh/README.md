# Daily DSH pin

First-class `@deepseek-ai/dsh` pin owned by `qq-core` and used by `bin/qq`.
Install the locked toolchain with:

```bash
npm ci --prefix dsh --no-audit --no-fund
```

`pins.json` is the machine-readable source of truth. The launcher preloads
`qq-dsh-model-compat.mjs` for the selected model metadata.
