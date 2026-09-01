# Daily DSH pin

First-class `@deepseek-ai/dsh` pin owned by `qq-core` and used by `bin/qq`.
Install the locked toolchain with:

```bash
npm ci --prefix dsh --no-audit --no-fund
```

`pins.json` is the machine-readable source of truth. The launcher preloads
`qq-dsh-model-compat.mjs` for the selected model metadata.

## Pin-bound sandbox compatibility patch

The pinned upstream rc.7 toolchain rejects stale `sandbox_permissions` values
that are equal to or narrower than a call's standing policy. That can strand
long-lived Agents after a tool-schema HMR even though the requested argument
cannot widen access. `npm ci --prefix dsh` therefore runs
`apply-pinned-patches.mjs`, which patches the canonical
`@deepseek-ai/dsh-sandbox` `approveEscalation` export in place. Bash, PowerShell,
and filesystem tools continue to consume that one shared helper; there is no
qq-core executor wrapper.

The patch is tied to the package version and exact before/after SHA-256 values
recorded in `pins.json`. Installation fails closed on any package or source
drift. Equal and narrower requests retain the standing policy without an
approval prompt; only strictly wider requests enter the existing approval
flow, and rejection still prevents execution. Escalation schema fields remain
optional.

Remove this compatibility patch (the `postinstall` hook and matching pin
metadata) when qq-core advances to a published `@deepseek-ai/dsh` revision that
contains the same centralized behavior upstream. After installing or changing
the pin, restart `qq.service`; changing an already-issued request is neither
required nor supported. Each subsequent model request naturally assembles tool
definitions from the live registry.
