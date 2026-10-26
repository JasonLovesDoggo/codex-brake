# Codex Brake

Let Codex spend this week's allowance. Stop it when next week's arrives.

A wrapper for Codex CLI and apps that use its app-server. Watches the weekly
reset time, with an increase in remaining allowance as a fallback. Once stopped,
work stays blocked until you resume.

## Install

Requires Node.js 22+, Linux or macOS, and Codex signed in with ChatGPT.
From this checkout:

```sh
npm install --global .
```

## Use

```sh
codex-brake exec "Finish the tests"
codex-brake review --uncommitted
```

For apps, set their Codex executable to `codex-brake` and restart their sessions.
T3 Code also has a setup shortcut: `codex-brake install-t3`.

```sh
codex-brake status
codex-brake pause     # Stop now
codex-brake resume    # Allow work again
codex-brake off       # Disable protection
```

Weekly only by default. Use `codex-brake arm --window either` to watch five-hour
resets too. Pauses are shared across wrapped sessions and survive restarts.

Supports `exec`, `review`, and stdio `app-server`; the interactive Codex terminal
UI is not supported. Plain `codex` bypasses the guard. In-flight requests may
spend tokens before cancellation finishes.

[Setup & configuration](docs/usage.md) · [Source notes](docs/sources.md) · [MIT](LICENSE)
