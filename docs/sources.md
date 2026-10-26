# Source notes

Inspected upstream source on 2026-10-25. Links below are pinned to the inspected
commits; they describe the integration surface, not a promise that every Codex or
T3 release has identical behavior.

- T3 Code: [`695f5c9963f59da6229e7386f9e45e64e91153c4`](https://github.com/pingdotgg/t3code/tree/695f5c9963f59da6229e7386f9e45e64e91153c4).
- Codex: [`970111f6cb62cc02fe36a82ea7d71b37a2889c97`](https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97).

## Codex provides an explicit deadline

The core [`RateLimitWindow`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/protocol/src/protocol.rs#L2544)
defines consumed percentage, rolling duration in minutes, and a reset timestamp
in Unix seconds. The app-server
[`RateLimitWindow`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L757)
serializes these as `usedPercent`, `windowDurationMins`, and `resetsAt`.
`usedPercent` is rounded to an integer at this boundary. Increasing remaining
allowance therefore appears as a decreasing consumed percentage.

The protocol registers
[`account/rateLimits/read`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server-protocol/src/protocol/common.rs#L1360)
and
[`account/rateLimits/updated`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server-protocol/src/protocol/common.rs#L2045).
The read handler fetches the backend account limits without starting a model
turn, and returns both a default snapshot and snapshots by limit ID. It requires
an eligible account login; ordinary API-key authentication is insufficient. See
[`get_account_rate_limits_response`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server/src/request_processors/account_processor.rs#L1150).

Notifications are explicitly
[sparse updates](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L658).
Missing/null metadata must not erase a previously observed value. Comparisons
must keep quota buckets and window durations separate rather than comparing
unrelated percentages.

These fields support two detection strategies: schedule a stop from an observed
reset deadline, and conservatively interpret a drop in consumed percentage as
an allowance refresh. The second strategy is a heuristic; corrections and
manual resets can also produce it. The implementation does not require a
separate event named "reset".

## T3's supported executable setting

T3 defines an editable Codex
[`binaryPath` setting](https://github.com/pingdotgg/t3code/blob/695f5c9963f59da6229e7386f9e45e64e91153c4/packages/contracts/src/settings.ts#L589)
with the UI label **Binary path**. Its
[launch helper](https://github.com/pingdotgg/t3code/blob/695f5c9963f59da6229e7386f9e45e64e91153c4/apps/server/src/provider/codexLaunchArgs.ts#L12)
adds `app-server` before the configured arguments. The
[adapter's process factory](https://github.com/pingdotgg/t3code/blob/695f5c9963f59da6229e7386f9e45e64e91153c4/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L1496)
uses that executable and forwards the Codex environment. This makes a stdio
wrapper sufficient; no T3 plugin loader or fork is needed.

T3 itself already
[reads account limits during provider checks](https://github.com/pingdotgg/t3code/blob/695f5c9963f59da6229e7386f9e45e64e91153c4/apps/server/src/provider/CodexProvider.ts#L562)
and
[handles limit notifications](https://github.com/pingdotgg/t3code/blob/695f5c9963f59da6229e7386f9e45e64e91153c4/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L4268).
The wrapper observes notifications to request a refresh, but performs its
comparisons only on serialized `account/rateLimits/read` responses. Codex's
rolling notifications can contain cached quota values, so directly comparing
them against newer reads could mistake stale usage for a reset. A failed
authoritative read latches a pause rather than silently disabling protection.
Specifically, core
[token-count events read the session's stored limits](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/mod.rs#L5351),
and the app-server
[forwards those limits as account notifications](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server/src/bespoke_event_handling.rs#L1639).

Managed ChatGPT connections are different: their
[runtime resolver replaces the configured executable](https://github.com/pingdotgg/t3code/blob/695f5c9963f59da6229e7386f9e45e64e91153c4/apps/server/src/provider/CodexManagedRuntime.ts#L125)
with T3's installed binary. Use the existing CLI login configuration. The
installed `0.0.46-nightly.20261011.2955` client was also inspected: its managed
provider UI displays **Binary path**, **Selected by T3 Code**, and a disabled
input. That confirms the limitation in the local build as well as upstream.

Server settings normally live at
[`<baseDir>/userdata/settings.json`](https://github.com/pingdotgg/t3code/blob/695f5c9963f59da6229e7386f9e45e64e91153c4/apps/server/src/config.ts#L144).
Provider overrides are under `providerInstances.<instanceId>.config`.
T3 [watches the settings file](https://github.com/pingdotgg/t3code/blob/695f5c9963f59da6229e7386f9e45e64e91153c4/apps/server/src/serverSettings.ts#L1108),
but already-launched processes still need replacement to use a new executable.

## Stopping work includes automatic continuation

T3's own
[orphan-goal handler](https://github.com/pingdotgg/t3code/blob/695f5c9963f59da6229e7386f9e45e64e91153c4/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L4404)
sends `thread/goal/set` with `status: "paused"` before `turn/interrupt`.
This demonstrates why merely interrupting the current turn is insufficient for
autonomous goals. Its
[interrupt implementation](https://github.com/pingdotgg/t3code/blob/695f5c9963f59da6229e7386f9e45e64e91153c4/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L7006)
also distinguishes a queued turn acknowledgment from a real `turn/started`
notification before interrupting it.

New model work can enter through `turn/start`, `turn/steer`, `review/start`,
compaction, or goal activation. A persistent pause must cover these entry points
and remain effective when the app-server connection is recreated.

T3 additionally
[invokes `codex exec` for text generation](https://github.com/pingdotgg/t3code/blob/695f5c9963f59da6229e7386f9e45e64e91153c4/apps/server/src/textGeneration/CodexTextGeneration.ts#L259)
through the same `binaryPath`. That command has no app-server transport. The
wrapper runs a separate passive app-server monitor for noninteractive `exec`
and `review`, verifies account usage before launching the command, and stops its
process group when the monitor pauses. This preserves automatic titles and
other auxiliary prose while using the same persistent guard. Unexpected monitor
exit or failed initialization also stops work. Other direct inference modes
remain blocked while armed or paused; `off` restores ordinary forwarding.
The passive monitor receives the command's configuration overrides and feature
flags. Profiles that app-server cannot mirror are rejected instead of monitoring
a potentially different account.
