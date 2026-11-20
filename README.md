# Better Remote Commander (BRC)

English | [简体中文](README_zh.md)

BRC helps you make full use of chat allowances across AI providers—such as ChatGPT's currently free tier, or Gemini's separate chat and coding quotas—to safely control your computer from a chat window. This brings agent capabilities close to a local harness directly into everyday conversations, including file management, terminal command execution, and system status monitoring.

Based on [shahidx0x/better-remote-commander](https://github.com/shahidx0x/better-remote-commander), rewritten and optimized with runtime auto-adaptation for Windows, Linux, and macOS.

## How It Works

```text
AI chat (remote MCP client)
  |
Public HTTPS endpoint (managed by you)
  |
Traefik (rate limit and concurrent-request limit)
  |
Relay (OAuth, device pairing, authorization)
  |
Agent (file and terminal tools on your computer)
```

The Agent opens an outbound WebSocket connection to Relay. It does not need a public listening port.

## Key Design

- **One global package**: `@inoceanlee/brc` installs the CLI, Relay, Agent, Traefik configuration templates, and native utilities. `brc setup` downloads the verified Traefik executable.
- **Manual lifecycle**: `brc start`, `brc stop`, and `brc status` manage the three services. BRC does not install an automatic system service.
- **Separate security layers**: Traefik limits request rate and concurrent requests; Relay verifies OAuth clients, pairing, and tool access. The Agent performs approved operations with the permissions of its local user account.
- **Centralized settings**: Edit `config/brc.yaml` or use `brc config`.

## Requirements

- Windows 10/11 x64, Linux x64/arm64, or macOS x64/Apple Silicon.
- Node.js 22.15.0 or newer and either pnpm or npm.
- Network access to GitHub during `brc setup` to download and verify Traefik.
- A public HTTPS endpoint for remote clients, configured separately from BRC.

**Public access is user-managed.** The HTTPS endpoint terminates TLS and forwards HTTP and WebSocket traffic to Traefik at `http://127.0.0.1:13001` (default). Tailscale Funnel or Cloudflare Tunnel can provide this entry point. BRC does not start or manage these tunnels.

## Installation and Quick Start

Open PowerShell on Windows, or a terminal with Bash/zsh on Linux or macOS. The commands below work in each shell.

**1. Install the package globally** (choose one package manager):

pnpm:

```sh
pnpm add -g @inoceanlee/brc
```

npm:

```sh
npm install -g @inoceanlee/brc
```

**2. Initialize BRC:**

```sh
brc setup
```

Choose an administrator name (default: `admin`) and a password of at least 8 characters. Setup writes the local configuration and downloads Traefik.

**3. Configure your HTTPS entry point:**

Set up the public HTTPS forwarding separately, then tell BRC its address:

```sh
brc config set services.publicUrl https://your-domain.example
```

Provide the HTTPS origin only; do not append `/mcp`.

**4. Start BRC and pair the device:**

```sh
brc start
brc status
brc logs agent
```

On first start, read the device verification URL and pairing code from the Agent log. Open the URL, approve the pairing, and confirm the Agent is online with `brc status`.

**5. Connect your AI chat client:**

In an AI chat client that supports remote MCP servers, add `https://your-domain.example/mcp`. Complete the client's OAuth authorization when prompted. The public entry point must support both HTTPS and WebSocket traffic.

## Common Commands

| Command                            | Purpose                                        |
| ---------------------------------- | ---------------------------------------------- |
| `brc help`                         | Show help and all commands                     |
| `brc start`                        | Start Relay, Traefik, and Agent in sequence    |
| `brc stop`                         | Stop all managed services                      |
| `brc restart`                      | Restart all managed services                   |
| `brc status`                       | Check service health and running status        |
| `brc status --json`                | Print service status as JSON                   |
| `brc logs [relay\|agent\|traefik\|cli]` | View service or CLI logs                  |
| `brc diagnose startup`             | Show the latest startup stage timings          |
| `brc diagnose functions`           | Show own-function call counts and durations    |
| `brc diagnose resources`           | Show per-process CPU, memory, and peaks        |
| `brc config show`                  | View effective configuration                   |
| `brc config get <key>`             | Read a specific configuration setting          |
| `brc config set <key> <value>`     | Update a setting and save atomically           |
| `brc config apply`                 | Apply manually edited YAML configuration       |
| `brc config path`                  | Display configuration file path                |
| `brc update traefik`               | Check and update Traefik binary                |
| `brc clean`                        | Clean temporary runtime data and invalid locks |
| `brc uninstall`                    | Remove services, data, and package             |

Update BRC to the latest version:

```sh
pnpm up -g @inoceanlee/brc --latest
# or
npm update -g @inoceanlee/brc
```

## Configuration and Data Storage

BRC keeps its configuration and private data in platform-specific locations:
- Windows: `%LOCALAPPDATA%\BRC\`
- Linux: `$XDG_DATA_HOME/brc` or `~/.local/share/brc`
- macOS: `~/Library/Application Support/brc`

Set `BRC_DATA_ROOT` to override the data root, or run `brc config path` to find the configuration file.

Logs live in `logs/` and diagnostic snapshots in `diagnostics/`; both follow configured retention and capacity limits. `brc start --timing` prints stage timings to stderr, and `brc diagnose ... --json` emits stable JSON for scripts. Async function durations include awaiting, and every resource peak states whether it came from the system counter or from sampling.

## Troubleshooting

- **Device awaiting pairing:** Run `brc logs agent` to get the current verification URL and code. Approve it in your browser, then run `brc status`.
- **MCP client cannot connect:** Verify all services with `brc status`. Check that your HTTPS entry point forwards to `http://127.0.0.1:13001` and supports WebSocket connections. Use the exact `https://your-domain.example/mcp` URL.
- **HTTP 401 from `/mcp`:** An unauthenticated request is expected to receive 401. Authorize the MCP client through the supported OAuth flow; do not disable Relay authentication.
- **Services fail to start:** Inspect `brc logs relay`, `brc logs traefik`, and `brc logs agent`. See [SECURITY.md](SECURITY.md) for trust boundaries.

## Uninstallation

**Keep configuration and private data:** Stop the services, then remove the package using the same package manager used for installation.

pnpm:

```sh
brc stop
pnpm remove -g @inoceanlee/brc
```

npm:

```sh
brc stop
npm uninstall -g @inoceanlee/brc
```

**Remove BRC completely:** This stops its services and permanently deletes its private data, including the Relay database, device credentials, configuration, and logs. It then removes the global package using the detected installation manager.

```sh
brc uninstall
```

On Windows, package removal starts after the command exits. Check the removal report path printed by BRC if removal fails. If the CLI remains installed, use `pnpm remove -g @inoceanlee/brc` or `npm uninstall -g @inoceanlee/brc`, matching your installation method. If the installation manager cannot be identified, BRC stops before deleting any data.

## License and Security

See [SECURITY.md](SECURITY.md) for security guidelines, [LICENSE](LICENSE) for the open-source license, and [NOTICE](NOTICE) for third-party attributions.
