# Web UI

AI Marketplace Monitor includes a built-in web interface for editing your configuration and monitoring activity in real time. The web UI starts automatically when you run the monitor — no extra setup needed.

For step-by-step instructions, examples, and 18 pictures, read the
[illustrated user guide](webui-guide.md).

![The Monitor console](images/webui/01-monitor.jpg)

## Overview

The **Monitor** view lists saved searches on the left and shows the selected
search’s description and recent activity on the right. **All activity** includes
unattributed events such as delivery results, with filters for type, search,
severity, AI score, and message text. Filters survive a reload. Scrolling to read
older activity or opening error details pauses updates until you follow live again.

Use **Edit** or **Add search** for guided forms. Fields can use their defaults or
an explicit value; Advanced options include first/subsequent search filters,
Boolean keyword expressions, seller filters, prompts, and sorting. Fixed start
times replace interval scheduling. **Search all now** requests every enabled
search after the current scan finishes; **Search now** on a saved search runs only
that one. Saving config changes may also restart
searches when the monitor reloads them.

**Settings** includes marketplace accounts/defaults, AI providers, users and shared
notification settings, proxies, custom regions, and the CodeMirror **config.toml**
editor. Languages and other custom options remain editable in TOML. Light and dark
themes follow your system by default; the header theme button cycles the preference.

Forms preserve TOML comments and unknown fields. Saves validate against all loaded
files and retain drafts on validation errors or a disk conflict. Conflict recovery
supports comparison, reapplying form edits to the current file, or explicitly
confirming an overwrite. Only the last loaded config file is editable; earlier
sources are listed in the TOML view. Lists combine across files, so removing an
inherited list entry requires editing its source file.

Secrets are shown as **Saved (hidden)** or as an environment reference such as
`${OPENAI_API_KEY}`. **Replace** sets a new value; leaving that input empty keeps
the existing value. New AI providers with no pasted key use the provider’s explicit
environment reference; that variable must be set before starting the monitor.
Saving does not test AI connectivity or notification delivery. Scalar secrets,
including multiline strings and quoted keys, round-trip without exposing their
values. Secret containers such as inline tables or arrays require moving the secret
to a scalar assignment in the source file before opening the editor.

Shared notification sections, including their defaults, overwrite matching user fields. Shared sections apply in their configured order. Use `notify_with`
to select the shared sections, or an explicitly empty list to apply none. The
user form’s **Use SMTP on this user only** helper excludes shared email settings.

**Export notified listings (CSV)** in All activity downloads the full cached
notification history, independent of feed filters. Recent activity is a bounded
in-memory buffer (2,000 events by default), rather than persistent results history.
AI ratings do not imply that a notification was sent; delivery events without a
search identifier appear only in All activity.

## Getting Started

Simply run the monitor:

```bash
ai-marketplace-monitor
```

The web UI is available at [http://127.0.0.1:8467](http://127.0.0.1:8467). A startup banner in the terminal shows the URL:

```
╭──────────── Web UI ────────────╮
│ 🌐  http://127.0.0.1:8467      │
│                                │
│ No password required           │
│ (local access only).           │
╰────────────────────────────────╯
```

On localhost, **no password is required**. Open the URL in your browser and start editing.

## Disabling the Web UI

If you don't need the web UI, disable it with:

```bash
ai-marketplace-monitor --no-webui
```

## Changing the Port

To use a different port:

```bash
ai-marketplace-monitor --webui-port 9090
```

## Advanced: Remote Access

By default, the web UI only listens on `127.0.0.1` (localhost) and requires no password. To access it from another machine on your network, you need to:

1. **Configure credentials** so the web UI is protected by a login screen.
2. **Bind to a network interface** so other machines can connect.
3. **Open a firewall port** if your system has a firewall enabled.

### Step 1: Set up username and password

The web UI uses your marketplace credentials for authentication. Set them in your config file:

```toml
[marketplace.facebook]
username = "you@example.com"
password = "your-password"
```

Or use environment variables:

```toml
[marketplace.facebook]
username = "${FACEBOOK_USERNAME}"
password = "${FACEBOOK_PASSWORD}"
```

Then set the environment variables in your shell before running the monitor:

```bash
export FACEBOOK_USERNAME="you@example.com"
export FACEBOOK_PASSWORD="your-password"
```

### Step 2: Bind to a network interface

Use `--webui-host` to listen on all interfaces:

```bash
ai-marketplace-monitor --webui-host 0.0.0.0
```

The startup banner will show all reachable URLs:

```
╭──────────────── Web UI ────────────────╮
│ 🌐  http://127.0.0.1:8467              │
│ 🌐  http://192.168.1.42:8467           │
│                                        │
│ user:      you@example.com             │
│ password:  (from marketplace config)   │
│                                        │
│ ⚠  Bound to non-loopback interface.    │
│    Consider TLS via a reverse proxy.   │
╰────────────────────────────────────────╯
```

You can also specify a port:

```bash
ai-marketplace-monitor --webui-host 0.0.0.0 --webui-port 9090
```

> **Note:** If no credentials are configured, `--webui-host` will refuse to start and display an error. This prevents accidentally exposing an unprotected editor on the network.

### Step 3: Open a firewall port

If your machine has a firewall, open the web UI port. For example, on Ubuntu with `ufw`:

```bash
sudo ufw allow 8467/tcp
```

On macOS, allow incoming connections through **System Settings > Network > Firewall**.

On Windows, add an inbound rule in **Windows Defender Firewall > Advanced Settings**.

> **Warning:** Exposing the web UI on a network means anyone who can reach the port can attempt to log in. Consider using a reverse proxy (nginx, Caddy, Tailscale) with TLS for encrypted connections, especially over untrusted networks.

## CLI Options Reference

| Option                  | Default     | Description                                         |
| ----------------------- | ----------- | --------------------------------------------------- |
| `--webui / --no-webui`  | `--webui`   | Enable or disable the web UI                        |
| `--webui-host`          | `127.0.0.1` | Bind address (requires credentials if not loopback) |
| `--webui-port`          | `8467`      | Port for the web UI                                 |
| `--webui-log-retention` | `2000`      | Number of log messages kept in memory               |
