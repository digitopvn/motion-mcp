# 0003. Explicit DirectorMode and capability handshake

## Status

Accepted.

## Context

Hosts differ. A Claude Opus host can author a creative spec itself, while a
small model or a script cannot. If Motion MCP always called its own Opus, a
frontier host would pay twice for taste. Guessing the host's ability from
client names or model ids is unreliable: clients do not report the model
reliably, names change, and a wrong guess either wastes money or produces weak
direction.

## Decision

- `directorMode` is one of `host-opus`, `internal-opus` or `custom`. It is set
  explicitly on each call, and a workspace default applies when the call omits
  it. The server never infers the mode from model names, client info or the
  user agent.
- The handshake is `motion_inspect({ target: "capabilities" })`. It returns the
  `CreativeSpec` JSON Schema, prompt guidance, pricing and limits, so a host
  can author a valid spec.
- A valid host spec skips the internal director. An invalid spec returns
  validation issues and costs no model call.
- In `host-opus` mode, creative critique is returned to the host as a critique
  request (see [DIRECTOR_PROTOCOL.md](../DIRECTOR_PROTOCOL.md)).

## Alternatives considered

| Option | Why it was not chosen |
|---|---|
| Infer the mode from `clientInfo` or model names | Unreliable and unverifiable, and it fails silently. |
| Always use internal Opus | Duplicates spend for frontier hosts, and ignores the host's context. |
| Always use the host | Fails for small hosts and scripts. |

## Reason

An explicit mode makes the cost and the behavior predictable, and it can be
tested. The handshake gives hosts everything they need to direct without a
side channel.

## Trade-offs

- Clients must opt in to `host-opus`, so a naive client gets `internal-opus`
  and pays for it.
- Host-mode critique adds a round trip through `awaiting_host`.

## Migration strategy

New modes are added to the enum as a minor, additive change. The handshake
advertises the supported modes, so clients can detect them.
