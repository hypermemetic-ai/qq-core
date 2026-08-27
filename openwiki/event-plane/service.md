---
title: In-process relay
---

# In-process relay

`qq-relay` is the DSH mailbox. It runs as a Cordis plugin in the core host and
uses full session UUIDs as durable identities. `relay_list`, `relay_send`, and
`relay_status` are its public model tools. Aliases are display-only.

There is no installed daemon, socket journal, polling queue, or second relay
generation in host composition. DSH session persistence records delivered
messages.
