# qq conversation browser QA

This is the focused browser QA for qq's server-rendered DSH conversation
surface. The fixture uses the production HTTP handler, renderer, CSS, browser
script, htmx/SSE path, and the presentation-neutral qq projection. Its adapter
is deterministic and in-memory: it makes no model call.

DSH remains authoritative for session events, pending inbox messages, claim
boundaries, and MessageIds. The fixture mirrors those facts so browser timing
is controllable; it is not a second transcript implementation.

## Automated boundary

Run the focused proofs first:

```bash
node tests/test-qq-host.mjs .
node tests/test-qq-conversation.mjs .
node tests/test-qq-ui-fiber.mjs .
tests/test-qq-host-live.sh
```

`test-qq-conversation` covers idle followup versus busy steer, prompt admission
without an idle wait, complete next-step batch handoff after parallel results,
pending edit/remove and replay, `keepInbox`, streaming/final coalescing,
reasoning visibility, tool/command pairing, objective expansion, compaction,
retries, and safe fallbacks. The live host proof uses the pinned DSH stack and
a localhost model stub only.

## Start the browser fixture

```bash
endpoint=$(mktemp)
node tests/qq-ui-browser-fixture.mjs "$endpoint" --live &
fixture_pid=$!
while [ ! -s "$endpoint" ]; do sleep 0.05; done
origin=$(cat "$endpoint")
printf '%s\n' "$origin/qq"
```

Open the printed URL in a clean Chromium profile. Retain the stable htmx nodes:

```js
window.__qa = {
  owner: document.querySelector('#console-stream'),
  target: document.querySelector('#session-panel'),
  messages: 0,
  opens: 0,
}
document.body.addEventListener('htmx:sseMessage', () => window.__qa.messages++)
document.body.addEventListener('htmx:sseOpen', () => window.__qa.opens++)
```

## Admission, live queue, and command plane

1. Send `show live work`. The POST returns promptly while status remains
   **Running turn 1**. The same composer still shows **Send** and the separate
   **Interrupt** control.
2. While it is running, send `steer one`, then `steer two`. Two separate
   **Steering** rows appear in FIFO order. They are not historical user bubbles
   yet and no second turn starts.
3. Edit the first row and save it. Remove the second. The row keeps its
   `data-message-id`; reload reconstructs the edited pending row from durable
   splice facts. Send `steer two` again if the complete two-row handoff is being
   checked.
4. Send `/workflows iterate` while still running. A muted
   `/workflows · iterate selected` receipt appears immediately and no pending
   queue row contains the slash line.
5. The fixture emits three parallel calls and all three results before its
   60-second safe boundary. Before that boundary the pending rows remain. At
   the boundary all next-step rows retire together into separate steering user
   entries, then one step-2 reasoning/text response appears. There is still one
   `turn/start`.

The fixture deliberately keeps the turn running for 120 seconds so desktop and
phone captures can inspect both Send and Interrupt. Interrupt at any point
before settlement: the turn becomes interrupted and still-pending rows remain.

## Streaming, reasoning, tools, and receipts

The deterministic first step proves these visual rules without a provider:

- reasoning appears as readable subordinate text, not a closed disclosure;
- assistant deltas and the final append occupy one assistant card;
- `read` settles as one collapsed successful row;
- terminal exit 2 is expanded with failed chrome;
- an image result is expanded and labeled as media;
- every parallel call has one row paired by call id;
- `/workflows iterate` is one muted durable receipt, not a receipt plus a
  duplicate notice.

Use the browser console for a compact assertion:

```js
({
  pending: [...document.querySelectorAll('.queue-item')].map(row => ({
    id: row.dataset.messageId,
    text: row.querySelector('.queue-edit-text')?.value,
  })),
  send: !!document.querySelector('#composer-submit'),
  interrupt: !!document.querySelector('#interrupt-submit'),
  reasoningVisible: !!document.querySelector('.assistant-reasoning'),
  routineCollapsed: !document.querySelector('[data-call-id^="read-"]')?.open,
  failureExpanded: document.querySelector('[data-call-id^="bash-"]')?.open,
  mediaExpanded: document.querySelector('[data-call-id^="media-"]')?.open,
  commandReceipt: [...document.querySelectorAll('.message-command')]
    .some(row => row.textContent.includes('/workflows')),
  ownerStable: window.__qa.owner === document.querySelector('#console-stream'),
  targetStable: window.__qa.target === document.querySelector('#session-panel'),
})
```

While a draft or pending-row editor has focus, let several SSE chunks arrive.
The local draft and selection survive the inner swap. Submitting clears only
the admitted draft; the submit control is disabled only for that short HTTP
admission.

## Desktop and Pixel layouts

Capture at **1280×800**, **412×915**, and the keyboard-reduced **412×520**.
At every size:

- pending messages stay as separate rows inside a capped scrolling dock;
- transcript, queue, and composer have no horizontal document overflow;
- visible reasoning stays subordinate to assistant text;
- routine tools stay dense while failed/media tools expose their result;
- Send and Interrupt remain separate controls while running;
- the phone composer ends at the viewport bottom.

Suggested checks:

```js
({
  viewport: [innerWidth, innerHeight],
  horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
  queueHeight: document.querySelector('#pending-queue')?.getBoundingClientRect().height,
  panelFits: Math.round(document.querySelector('#session-panel').getBoundingClientRect().width) === innerWidth,
  composerBottom: Math.round(document.querySelector('#composer').getBoundingClientRect().bottom),
})
```

## Reconnect and safety

Force the fixture SSE connection closed:

```bash
curl -fsS "$origin/__proof/disconnect"
```

After reconnect, the event projection and pending inbox rows reconstruct from
the same authority. `#console-stream` and `#session-panel` retain identity.
Script-looking prompt text stays escaped. The service worker caches only
presentation assets; pages, transcripts, SSE, prompts, queue mutations, and
interrupts remain network-only and fail closed offline.

Stop the fixture:

```bash
kill "$fixture_pid"
wait "$fixture_pid" || true
```
