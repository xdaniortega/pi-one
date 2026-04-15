# Pi-One

**The only AI agent with secure wallet management.**

Your agent signs transactions across 9 blockchains. The private keys never enter its memory.

Built on the [Open Wallet Standard](https://openwallet.sh/) with process-isolated key management -- the agent and the signer run in separate containers, connected by a Unix socket. A prompt injection compromises the agent, not the keys.

## The Problem

Every other agent wallet puts the keys in the same process as the LLM. One prompt injection and the attacker has everything -- keys, shell, your home directory. OWS [planned a subprocess enclave](https://github.com/open-wallet-standard/core) to fix this but hasn't built it yet. We implement it with Docker.

```
┌────────────────────────────────────────────────────────────────┐
│  Your laptop (clean -- no OWS, no wallet data, no secrets)     │
│                                                                │
│  ┌────────────────────────┐   ┌─────────────────────────────┐  │
│  │  KMS Container         │   │  Agent Container            │  │
│  │                        │   │                             │  │
│  │  OWS + encrypted vault │   │  Pi (RPC mode)              │  │
│  │  Passphrase (file)     │   │  Wallet skill               │  │
│  │  Approval queue        │   │                             │  │
│  │  Audit log             │   │  Starts with NO token       │  │
│  │                        │   │  Requests one from KMS      │  │
│  │  read-only rootfs      │   │  Waits for your approval    │  │
│  │  cap_drop: ALL         │   │                             │  │
│  │  no internet           │   │  Does NOT have:             │  │
│  │                        │   │  - passphrase               │  │
│  │  Keys in memory only   │   │  - wallet files             │  │
│  │  during signing (ms)   │   │  - OWS binary               │  │
│  │                        │   │  - your home directory      │  │
│  └───────────┬────────────┘   └──────────────┬──────────────┘  │
│              │        Unix socket             │                 │
│              └────────────────────────────────┘                 │
└────────────────────────────────────────────────────────────────┘
```

The agent signs. It never sees the key.

## Quickstart

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- An LLM API key (Anthropic, OpenRouter, or OpenAI)

### 1. Clone and configure

```bash
git clone <repo-url> pi-one && cd pi-one
cp .env.example .env
# Edit .env -- set one of: ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY
```

### 2. Start

```bash
# Full stack: KMS + Pi agent with wallet skill
docker-compose up

# Or KMS only: if you already have an agent
docker-compose up ows-vault
```

On first boot, the KMS creates the wallet. The mnemonic appears in the logs:

```
════════════════════════════════════════════════
  Pi-One KMS Initialization
════════════════════════════════════════════════

  ╔══════════════════════════════════════════════╗
  ║  BACKUP YOUR MNEMONIC (shown once only):    ║
  ╠══════════════════════════════════════════════╣
  ║  goose puzzle decorate fence march valley ...║
  ╚══════════════════════════════════════════════╝

  Wallet created: pi-treasury
  No agent tokens created. Agents must request their own.
════════════════════════════════════════════════
```

**Write down the mnemonic.** It is shown once and never again. Subsequent starts skip initialization.

### 3. Approve the agent's first token

The agent starts with **no token**. It automatically requests one from the KMS and waits for your approval:

```
[bootstrap] No token found. Requesting from KMS...
[bootstrap] Request submitted: req_abc123
[bootstrap] Waiting for approval...
```

Approve it:

```bash
# See the pending request
docker-compose exec ows-vault node src/manage.js requests

# Approve it
docker-compose exec ows-vault node src/manage.js approve req_abc123
```

The agent picks up the token and starts. No token is ever auto-provisioned -- you approve every one.

### 4. Use the wallet

Open an interactive console with the agent:

```bash
docker-compose up -d
docker attach pi-one-pi-agent-1
```

You can now chat with the agent. For example:

```
> What's my EVM wallet address?
> Sign this message on EVM: "hello world"
> What chains can I sign on?
```

The agent uses the [wallet](skills/wallet/SKILL.md) and [ows](skills/ows/SKILL.md) skills automatically to translate your request into the right CLI calls.

Supported chains: `evm`, `solana`, `bitcoin`, `cosmos`, `tron`, `ton`, `sui`, `spark`, `filecoin`.

## Key Management

### How tokens work

The agent starts with no token. On boot, it requests one from the KMS. You approve it. If the agent later needs a capability its token doesn't permit, it gets `POLICY_DENIED` and requests a new one.

```
Agent boots  → Requests initial token → You approve → Agent can sign
                                                       │
Agent later  → Tries to send a tx     → POLICY_DENIED  │
             → Requests tx capability  → You approve    │
             → Retries with new token  → Success ───────┘
```

The agent **cannot self-mint tokens**. Every capability -- including the first one -- requires your approval.

### Managing keys

All wallet management happens via `docker-compose exec` into the KMS container:

```bash
# See pending requests from the agent
docker-compose exec ows-vault node src/manage.js requests

# Approve a request (optionally with tighter TTL)
docker-compose exec ows-vault node src/manage.js approve <id>
docker-compose exec ows-vault node src/manage.js approve <id> --ttl "1h"

# Deny a request
docker-compose exec ows-vault node src/manage.js deny <id> --reason "Not needed"

# List all API keys
docker-compose exec ows-vault node src/manage.js keys

# List wallets and addresses
docker-compose exec ows-vault node src/manage.js wallets
```

## Architecture

### What's in each container

| | KMS (ows-vault) | Agent (pi-agent) |
|---|---|---|
| OWS binary | Yes | No |
| Wallet files | Yes (encrypted) | No |
| Passphrase | Yes (in vault volume) | No |
| Agent tokens | Token hashes only | Its own token (in tmpfs, after approval) |
| Signing capability | Yes | No (delegates to KMS) |
| Internet access | No | Configurable |
| Filesystem | Read-only (except vault volume) | Read-only (tmpfs for /work, /tmp) |
| Capabilities | All dropped | All dropped |
| User | Non-root (ows) | Non-root (agent) |

### How signing works

```
1. Agent calls: wallet.js sign --chain evm --message "hello"
2. wallet.js reads token from /tmp/agent/approved-tokens.json
3. wallet.js sends HTTP request to KMS via Unix socket
4. KMS detects ows_key_ prefix → agent mode
5. KMS checks policies → PASS
6. KMS decrypts mnemonic via HKDF(token) → mlock'd memory
7. KMS derives chain key via BIP-44
8. KMS signs message
9. KMS zeroizes mnemonic + key from memory
10. Returns signature to agent
```

The mnemonic exists in memory for milliseconds, only in the KMS container.

### How token bootstrap works

```
1. Agent starts → no token file exists
2. bootstrap-token.js sends POST /keys/request to KMS (no auth needed)
3. KMS queues the request → returns request_id
4. bootstrap-token.js polls GET /keys/request/:id every 5 seconds
5. You approve via docker-compose exec
6. KMS creates the OWS API key → returns token in poll response
7. bootstrap-token.js saves token to /tmp/agent/approved-tokens.json
8. Pi agent starts with wallet skill loaded
```

The Unix socket is the authentication boundary -- only containers on the internal Docker network can reach it.

### Docker volumes

| Volume | Purpose | Mounted in |
|--------|---------|-----------|
| `ows-vault-data` | Encrypted wallet, passphrase, keys, audit log | KMS only |
| `ows-sock` | Unix socket (tmpfs) | KMS (rw), Agent (ro) |

No shared secrets volume. The agent's token lives in its own tmpfs (volatile, lost on restart -- agent re-bootstraps). No volume is host-mounted. Your laptop has zero OWS footprint.

## Testing

The project has 52 tests across 4 suites:

```bash
# KMS signing tests (12 tests)
node --test tests/kms/signing.test.js

# KMS approval queue tests (11 tests)
node --test tests/kms/queue.test.js

# End-to-end integration tests (11 tests)
node --test tests/integration/e2e.test.js

# Wallet skill script tests (18 tests)
node tests/skills/scripts.test.js

# Run everything
node --test tests/kms/signing.test.js tests/kms/queue.test.js tests/integration/e2e.test.js && node tests/skills/scripts.test.js
```

Tests create temporary vaults and run against a local KMS -- no Docker required for testing.

## Project Structure

```
pi-one/
├── kms/                          # KMS service (runs in ows-vault container)
│   ├── src/
│   │   ├── server.js             # HTTP server over Unix socket + auto-init
│   │   ├── ows.js                # OWS SDK wrapper
│   │   ├── queue.js              # Approval queue (request/approve/deny)
│   │   └── init.js               # Wallet initialization (no token creation)
│   └── package.json
├── skills/
│   └── wallet/                   # Agent Skills standard
│       ├── SKILL.md              # Skill definition (Pi reads this)
│       └── scripts/
│           └── wallet.js         # Single CLI: sign, address, capabilities, request, check
├── scripts/
│   └── bootstrap-token.js        # Agent entrypoint: request token, wait for approval
├── docker/
│   ├── kms.Dockerfile            # KMS container (node + OWS)
│   └── agent.Dockerfile          # Agent container (node + Pi + skill + bootstrap)
├── tests/
│   ├── kms/
│   │   ├── signing.test.js       # Signing endpoint tests
│   │   └── queue.test.js         # Approval queue tests
│   ├── skills/
│   │   └── scripts.test.js       # wallet.js script tests
│   └── integration/
│       └── e2e.test.js           # Full bootstrap → approve → sign → escalate
├── docker-compose.yml
├── .env.example
└── package.json
```

## Security Model

### What we get from containers

| Threat | Without Docker | With Pi-One |
|--------|---------------|-------------|
| Prompt injection | Agent has your filesystem + keys. Game over. | Agent can only sign within policy limits. Can't read ~/.ssh. |
| Key isolation | Agent and signer share memory. | Separate containers. Agent never has key material. |
| Capability escalation | Agent has static, permanent access. | Human approves every capability, including the first. |
| Multi-agent | All agents share permissions. | Each agent: own container, own token, own network. |

### Token lifecycle

- Agent starts with **no token** (zero trust)
- First token requires explicit human approval
- Tokens live in agent's tmpfs (volatile -- lost on container restart)
- Agent re-bootstraps on every restart (requests new token, you approve)
- No token is ever auto-provisioned or persisted to disk

### What we accept

- `mlock()` fails without `IPC_LOCK` -- OWS handles this gracefully, swap risk is theoretical
- Host root can access Docker volumes -- inherent to local dev, use external KMS for production
- Agent's token can sign within policy limits if exfiltrated -- this is by design (policies ARE the limit)

## License

MIT
