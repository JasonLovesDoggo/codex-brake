# Setup and configuration

Codex Brake watches Codex usage and stops wrapped work at a quota reset.
Weekly resets are the default; five-hour resets are ignored unless selected.

## Codex CLI

Install from this checkout with `npm install --global .`, then use
`codex-brake exec "your task"` or `codex-brake review --uncommitted`.
These commands run beside a passive usage monitor. No T3 installation is needed.

## Apps using Codex

Set the app's Codex executable to the absolute path returned by
`command -v codex-brake`, then restart its sessions. The app must use
`codex app-server` over stdio and let you select its executable. Managed
installations that choose their own binary cannot use this integration.

## T3 Code

You need Linux or macOS, Node.js 22 or newer, npm, an installed Codex CLI, and a
working ChatGPT login through `codex login`. Linux is tested. The wrapper uses
POSIX process groups to stop descendant processes; Windows is not supported.
The Codex executable must support `app-server` and account rate limits. This
package has no runtime dependencies.

From this repository:

```sh
npm install --prefix "$HOME/.local" --global .
"$HOME/.local/bin/codex-brake" --version
"$HOME/.local/bin/codex-brake" arm --window weekly
"$HOME/.local/bin/codex-brake" install-t3
```

`--version` checks the underlying Codex installation. Add `$HOME/.local/bin` to
your shell's `PATH` to use the shorter commands below.

`install-t3` configures the `codex` provider in
`~/.t3/userdata/settings.json`, preserves other settings, and creates a backup
before changing an existing file. Running it again with the same path makes no
changes. For a different T3 settings location:

```sh
codex-brake install-t3 --settings /absolute/path/to/settings.json
```

Restart T3's Codex sessions so they launch through the wrapper. Existing
processes do not acquire protection when you change the setting. Check
`codex-brake status` after starting a session; an armed guard needs a
rate-limit observation to establish its reset deadline or usage baseline.

To configure manually, open **Settings → Providers**, select your existing Codex
CLI provider, and set **Binary path** to the absolute installed wrapper path,
for example `/home/you/.local/bin/codex-brake`. Select the correct
environment if you use a remote machine. The installer targets the default
`codex` instance; configure additional CLI instances in this UI.

T3's managed **Connect with ChatGPT** setup selects its own binary and cannot use
this integration. Use an existing Codex CLI login and the editable Binary path
field. A disabled field labelled **Selected by T3 Code** indicates the managed
setup.

If T3 cannot find the real Codex executable, set `CODEX_BRAKE_CODEX_BINARY` to its
absolute path in the provider's environment. If you previously used a custom
Codex Binary path, use that previous path here. Do not point it back at
`codex-brake`.

## Everyday use

```sh
codex-brake arm                      # Watch the weekly window
codex-brake arm --window weekly      # Watch only the weekly window
codex-brake arm --window either      # Watch either quota window
codex-brake arm --window five-hour   # Watch only the five-hour window
codex-brake status
codex-brake status --json
codex-brake pause                    # Stop wrapped work now
codex-brake resume                   # Clear the stop and establish new baselines
codex-brake off                      # Disable reset protection
```

The window choices are `either`, `weekly`, and `five-hour`; `weekly` is the
default. `resume` rearms the guard like `arm`. Neither command resubmits a message,
restarts an interrupted turn, or resumes a paused Codex goal. Continue that work
yourself in your app or terminal when ready.

The pause survives process exits and app restarts. Every wrapper using the same
state directory shares the stop, so another thread cannot silently continue
spending the refreshed allowance. Use a separate `CODEX_BRAKE_STATE_DIR` for each
account if you want independent controls; run control commands with that same
environment setting.

## How it detects a reset

Codex exposes `account/rateLimits/read` and `account/rateLimits/updated`, including
each window's `resetsAt` Unix timestamp and `usedPercent`. The wrapper compares
serialized, authoritative `account/rateLimits/read` responses. Notifications can
contain cached values, so they only prompt a fresh read. The wrapper uses the
reported deadline rather than waiting for a completed model request to reveal a
reset. It also treats a decrease in consumed percentage as a reset: **more
allowance remaining means less `usedPercent`**, not more.

The percentage comparison is a conservative fallback. A backend correction or a
manual allowance reset can also trigger it. The guard does not stop just because
normal work increases consumed usage or because a window becomes exhausted.
If usage monitoring fails, the guard latches a pause and requires an explicit
resume after the problem is fixed.

When stopped, the wrapper blocks new model work and requests interruption of
active turns, including observed Codex child turns. It also requests that active
native goals pause, so automatic goal continuation cannot simply start another
turn. T3 displays the interrupted work or the guard's blocked-request error.

## Scope and limits

Only Codex processes launched through this wrapper are covered. Other providers,
other machines, already-running Codex processes, and direct invocations of the
real `codex` executable are outside its control. This does not close T3 Code or
pause its whole scheduler.

T3's auxiliary `codex exec` calls, including automatic titles and commit text,
remain supported. Noninteractive `exec` and `review` commands run beside a
passive app-server monitor. They start only after the monitor verifies account
usage; a reset, manual pause, or monitor failure stops the command and its POSIX
process group. The monitor does not consume the command's stdin or start a
model turn itself. While paused, neither conversation turns nor these auxiliary
commands can start.

The passive monitor receives CLI `--config`/`-c`, feature toggles, and
`--strict-config` overrides so it uses the command's configuration. Guarded CLI
commands reject `--profile`/`-p`, which the app-server monitor cannot mirror; use
`CODEX_HOME` or explicit configuration overrides for that account instead.

Other direct inference modes, including interactive chat, are blocked while the
guard is armed or paused. Use `off` to restore ordinary CLI forwarding. Version,
help, login, and MCP management commands remain available.

Stopping is best effort: an unexpected reset can be discovered only after the
next notification or poll, and an in-flight model request can spend tokens before
interruption takes effect. Guarded CLI work can also continue between an
unexpected reset and its detection. This is not a guarantee of zero usage after
a reset.
API-key accounts and providers that do not expose Codex account limits cannot
provide the same reset information.

## Configuration

Set these in the shell or your app's Codex process environment when needed. An environment variable
exported only in a terminal may not reach a separately launched desktop app.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_BRAKE_CODEX_BINARY` | `codex` | Real Codex executable to launch. |
| `CODEX_BRAKE_STATE_DIR` | `$XDG_STATE_HOME/codex-resetstop`, or `~/.local/state/codex-resetstop` | Shared persistent guard state. Use the same path for CLI controls and T3. |
| `CODEX_BRAKE_POLL_MS` | `15000` | Interval between account rate-limit polls, in milliseconds. |
| `CODEX_BRAKE_REQUEST_TIMEOUT_MS` | `10000` | Timeout for monitor initialization and account requests, in milliseconds. |
| `CODEX_BRAKE_STOP_GRACE_MS` | `1000` | Grace period for stopping active turns and CLI work, in milliseconds. |

For local verification:

```sh
npm test
```

The protocol and integration choices are documented in
[the pinned source notes](sources.md).


## Upgrading from codex-resetstop

`codex-resetstop` remains a command alias. The `RESETSTOP_*` environment
variables still work; `CODEX_BRAKE_*` takes precedence when both are set.
The default state directory keeps its original `codex-resetstop` name so
running sessions and upgraded wrappers share the same pause. Renaming the
tool does not rearm it or discard its saved reset deadline.
