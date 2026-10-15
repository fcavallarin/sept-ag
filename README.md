# sept-ag

**Secure remote MCP access without VPNs, public endpoints, or complex networking setups.**

`sept-ag` is an experimental bridge that lets AI agents discover and invoke tools exposed by MCP servers on other networks, without exposing those servers to the internet.

It provides:

- **Cross-network connectivity** — Reach MCP servers on private networks without a VPN or inbound ports.
- **Per-agent, per-tool permissions** — Grant or revoke individual tools without changing the MCP server's configuration or its own authorization rules.
- **End-to-end encryption** — Tool calls and responses travel encrypted between endpoints, including when routed through a third-party relay.
- **Offline delivery** — Calls sent while a remote endpoint is disconnected can still be delivered and executed after it reconnects, even if the agent's original request has timed out.

Offline execution does not yet mean asynchronous MCP result handling: an agent might not receive a late response, although it can verify completion independently (for example, by polling or through an external webhook). Native task tracking and result retrieval are planned; see [Future Work](#future-work).

Under the hood, `sept-ag` uses [SEPT](https://github.com/fcavallarin/sept), an open-source encrypted event protocol that handles transport, device identities, access control, and offline delivery.

## Current Scope

The prototype currently supports:

- MCP initialization
- Tool discovery
- Tool calls
- Per-tool grant/revoke
- One client connected to one MCP server

MCP prompts, resources, and notifications are intentionally out of scope for the first demo.

## Example

A newly connected client has no tools available by default. An administrator can grant access to one tool:

```bash
node src/cli.js admin grant-tool my-connection get_door_state
```

The client can then discover and invoke `get_door_state`. Revoking the permission prevents subsequent invocations, even if the agent still has the tool in a cached tool list.

## Quick Start

Connect an AI agent to an MCP server on another network and manage exactly which tools it can use.

There are three components:

- **Server** — Runs alongside an existing MCP server and makes its tools reachable remotely.
- **Client** — Presents authorized remote tools to an AI agent through a local MCP endpoint.
- **Admin** — Pairs the endpoints and manages tool permissions.

These components can run on separate networks. No VPN or publicly exposed MCP endpoint is required.

### 1. Installation

On each machine running `sept-ag`:

```bash
git clone https://github.com/fcavallarin/sept-ag.git
cd sept-ag
npm install
```

### 2. Configure the server

On the machine hosting your MCP server, create `config.json`:

```json
{
  "server": {
    "id": "my-server",
    "transport": "streamable-http",
    "url": "http://localhost:8931/mcp"
  }
}
```

Replace the URL with your MCP server's local endpoint and ensure that it is running.

Start the bridge:

```bash
node src/cli.js server
```

On its first run, it displays Base64-encoded pairing data and prompts for a pairing PIN. Leave the terminal running; pairing will be completed in step 4.

### 3. Configure the client

On the machine running your AI agent, create `config.json`:

```json
{
  "client": {
    "id": "my-agent",
    "listenHost": "127.0.0.1",
    "port": 8001
  }
}
```

Start the local MCP bridge:

```bash
node src/cli.js client
```

On first run, it also displays pairing data and asks for a PIN. Leave this terminal running.

**Note:** The server, client, and Admin each need their own working directory and `config.json`. If you run all three on the same machine, use separate copies/directories to avoid conflicting configurations.

### 4. Connect the client and server

In a third terminal, connect them using the pairing data displayed by each endpoint:

```bash
node src/cli.js admin connect my-connection \
  "<CLIENT_PAIRING_DATA>" \
  --new-server "<SERVER_PAIRING_DATA>"
```

The Admin initializes the underlying private network if necessary and generates pairing PINs for both endpoints. Enter each PIN in the corresponding terminal.

Once pairing completes, the endpoints have the permissions needed to exchange MCP requests and responses. **No MCP tools are granted by default.**

### 5. Grant access to a tool

Inspect the connection and its available tools:

```bash
node src/cli.js admin connection my-connection
```

Grant one tool:

```bash
node src/cli.js admin grant-tool my-connection get_door_state
```

Replace `get_door_state` with a tool exposed by your MCP server. To grant all available tools:

```bash
node src/cli.js admin grant-all my-connection
```

Tool permissions are enforced by the bridge's underlying access-control layer, independently of the MCP server's own authorization mechanisms.

### 6. Connect your AI agent

Configure your MCP-compatible agent to use this local Streamable HTTP endpoint:

```text
http://127.0.0.1:8001/mcp
```

The agent can discover and invoke only the tools permitted for its connection. Requests are encrypted and forwarded to the remote bridge, which invokes the local MCP server and returns its response.

### 7. Revoke access

Revoke access to one tool:

```bash
node src/cli.js admin revoke-tool my-connection get_door_state
```

Or revoke all tools:

```bash
node src/cli.js admin revoke-all my-connection
```

Inspect the connection again:

```bash
node src/cli.js admin connection my-connection
```

Revocation blocks subsequent calls even if the agent cached the old tool list. The agent may need to refresh tool discovery to reflect the change in its UI.

## How It Works

```text
AI Agent
   |
   | MCP (localhost)
   v
Remote MCP Client Bridge
   |
   | Encrypted relay transport
   | Per-agent, per-tool permissions
   v
Remote MCP Server Bridge
   |
   | MCP (local)
   v
MCP Server
```

The relay forwards encrypted messages without access to tool-call contents. Each endpoint has its own cryptographic identity, and an administrator controls which tools each client can invoke. No inbound ports, VPN connections, or public MCP endpoints are required between client and server.

## Remote Agent Interaction

The same encrypted communication infrastructure can also connect users directly to AI agents, including from mobile apps. This makes it possible to chat with an agent running on a private network while the agent accesses MCP tools hosted elsewhere.

```text
Mobile App / User
        |
        | Encrypted chat / commands
        v
     AI Agent
        |
        | MCP (localhost)
        v
  MCP Client Bridge
        |
        | Encrypted remote access
        | Per-tool permissions
        v
  MCP Server Bridge
        |
        | MCP (local)
        v
     MCP Server
```

The underlying protocol already supports secure user-to-agent messaging. **Chat integration is not currently a feature of `sept-ag` itself.**

## Relay Configuration

By default, `sept-ag` uses a free public relay. You can also [self-host a relay](https://github.com/fcavallarin/sept/blob/main/docs/self-hosting.md).

To use a different relay, add this field to the top-level object in each component's `config.json`:

```json
{
  "sept": {
    "restEndpoint": "https://YOUR-SEPT-RELAY"
  }
}
```

Merge this `sept` field into your existing server, client, or Admin configuration; don't replace the other fields.

## Future Work

### Asynchronous MCP Tool Execution

The transport already supports persistent offline delivery: a call can reach a disconnected endpoint when it comes back online. But standard MCP tool calls use a request/response model, so the originating agent may time out before the call is executed and may never receive its eventual result.

A future version could use the [MCP Tasks Extension](https://tasks.extensions.modelcontextprotocol.io/) to provide native asynchronous execution and result retrieval:

1. An agent invokes a remote tool.
2. The client bridge persists a task and immediately returns a task identifier.
3. The request is queued for delivery even if the remote endpoint is offline.
4. On reconnection, the server bridge invokes the existing MCP server.
5. The result is delivered back and associated with the task.
6. The agent retrieves the result with `tasks/get` or receives an optional `notifications/tasks` update.

This requires persistent task state, request/result correlation, execution deduplication, expiration policies, and cancellation handling. **Existing MCP servers would not need to implement asynchronous execution**: the bridge could manage the task lifecycle while continuing to invoke ordinary MCP tools.

This is planned work, **not a feature of the current prototype**.

## Status

`sept-ag` is an experimental prototype/demo and is not yet published on npm.

## Related

- [SEPT](https://github.com/fcavallarin/sept) — underlying encrypted event transport and access-control protocol
