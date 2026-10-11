# sept-ag

`sept-ag` is an experimental bridge for connecting MCP clients and servers over [SEPT](https://github.com/fcavallarin/sept).

It enables secure MCP communication across different networks without VPNs or publicly exposed endpoints, with fine-grained, per-client and per-tool authorization enforced through SEPT ACLs.

An administrator can grant or revoke access to individual MCP tools without modifying the MCP server or its configuration.

SEPT's built-in offline delivery also enables **deferred tool execution**: if a remote MCP server is temporarily offline, tool calls can be delivered and executed when it reconnects, even if the original MCP request has already timed out. While the agent won't automatically receive late results, completion can be verified through other mechanisms, such as polling or external webhooks. Future support for asynchronous MCP tasks aims to provide native result retrieval and notifications (see [Future Work](#future-work)).

## Current scope

The current prototype focuses on a deliberately small MCP subset:

- MCP initialization
- Tool discovery
- Tool calls
- Per-tool grant/revoke
- One client connected to one MCP server

Prompts, resources, and MCP notifications are intentionally out of scope for the first demo.

## Example

A client can initially connect with no tools available. An administrator can then grant access to a specific MCP tool:

```bash
node src/cli.js admin grant-tool my-connection get_door_state
```

After the grant, the MCP client can discover and call that tool. Revoking the grant prevents further calls, even if the agent still has the tool in its previously discovered tool list.

## Quick Start

This guide shows how to connect an MCP client to a remote MCP server through SEPT and control access to individual tools.

We'll use three components:

- **Server** — Connects to an existing MCP server and exposes its tools over SEPT.
- **Client** — Exposes authorized remote tools through a local MCP endpoint.
- **Admin** — Pairs the devices and manages per-tool permissions.

The client and server can run on different networks, without a VPN or publicly exposed MCP endpoint.

### 1. Installation

On each machine running SEPT-AG:

```bash
git clone https://github.com/fcavallarin/sept-ag.git
cd sept-ag
npm install
```

### 2. Configure the server

On the machine hosting the MCP server, create a `config.json`:

```json
{
  "server": {
    "id": "my-server",
    "transport": "streamable-http",
    "url": "http://localhost:8931/mcp"
  }
}
```

Replace the URL with the endpoint of your existing MCP server. Make sure that the MCP server is running and reachable locally.

Start SEPT-AG:

```bash
node src/cli.js server
```

On its first run, the server displays Base64-encoded pairing data and asks for a pairing PIN.

Keep this terminal running. You'll complete pairing from the Admin in step 4.

### 3. Configure the client

On the machine where your AI agent runs, create a `config.json`:

```json
{
  "client": {
    "id": "my-agent",
    "listenHost": "127.0.0.1",
    "port": 8001
  }
}
```

Start the client:

```bash
node src/cli.js client
```

Like the server, the client displays pairing data on its first run and asks for a PIN.

Keep this terminal running as well.

**Note:** The examples assume the server, client, and Admin each run from a separate working directory with their own `config.json`. If you run all three on the same machine, use separate copies/directories so their configurations don't overwrite one another.

### 4. Connect the client and server

On a third terminal, create a connection using the pairing data printed by the client and server:

```bash
node src/cli.js admin connect my-connection \
  "<CLIENT_PAIRING_DATA>" \
  --new-server "<SERVER_PAIRING_DATA>"
```

The Admin initializes its own SEPT network if necessary, then generates pairing PINs for both devices.

Enter the corresponding PIN in each device's terminal.

Once pairing is complete, the Admin establishes the permissions required for MCP communication.

**No MCP tools are granted by default.**

### 5. Grant access to a tool

Inspect the connection and its available tools:

```bash
node src/cli.js admin connection my-connection
```

Grant access to a specific tool:

```bash
node src/cli.js admin grant-tool my-connection get_door_state
```

Replace `get_door_state` with the name of a tool exposed by your MCP server.

Alternatively, grant access to all available tools:

```bash
node src/cli.js admin grant-all my-connection
```

Permissions are enforced by SEPT, independently of the MCP server's own authorization mechanisms.

### 6. Connect your AI agent

The SEPT-AG client exposes a local MCP endpoint:

```text
http://127.0.0.1:8001/mcp
```

Configure your MCP-compatible agent to use this endpoint with the Streamable HTTP transport.

The agent can discover and invoke only the tools authorized for its SEPT device.

Tool calls are forwarded through the encrypted SEPT connection to the remote MCP server, and responses are delivered back to the agent.

### 7. Revoke access

Revoke permission to a specific tool:

```bash
node src/cli.js admin revoke-tool my-connection get_door_state
```

Or revoke all tool permissions:

```bash
node src/cli.js admin revoke-all my-connection
```

You can inspect the connection again:

```bash
node src/cli.js admin connection my-connection
```

Revocation prevents subsequent tool calls, even if an agent still has the tool in its cached tool list. The client may need to refresh its MCP tool list to reflect updated permissions in discovery results.


## Remote Agent Interaction

SEPT can also be used as a secure communication channel between users and AI agents, including through mobile applications.

This enables users to interact with agents running on private networks without exposing public endpoints or requiring VPN access.

Combined with SEPT-AG, this opens up an end-to-end architecture where users communicate with agents over SEPT, while agents securely access remote MCP tools through the same protocol.

Both communication paths benefit from end-to-end encryption, device identities, and distributed access control.

While SEPT already provides the underlying communication capabilities, user-to-agent chat integration is not currently part of SEPT-AG.

```
Mobile App / User
        |
        | SEPT (E2E encrypted)
        | Chat / Commands
        v
     AI Agent
        |
        | MCP (localhost)
        v
  SEPT-AG Client
        |
        | SEPT (E2E encrypted)
        | Per-tool ACL
        v
  SEPT-AG Server
        |
        | MCP (local)
        v
     MCP Server
```

## SEPT Relay

By default, `sept-ag` uses a free, public SEPT relay. You can also [self-host your own](https://github.com/fcavallarin/sept/blob/main/docs/self-hosting.md).

To point `sept-ag` to a different relay, add the following section to each component's `config.json` (inside the top-level JSON object):

```json
"sept": {
  "restEndpoint": "https://YOUR-SEPT-RELAY"
}
```

## How it works

```text
AI Agent
   |
   | MCP (localhost)
   v
SEPT-AG Client
   |
   | SEPT (E2E encrypted)
   | Per-tool ACL
   v
SEPT-AG Server
   |
   | MCP (local)
   v
MCP Server
```

The SEPT relay forwards encrypted events without needing access to their contents. Each client has its own cryptographic identity, and the Admin controls which tools it may invoke.

No inbound ports, VPN connections, or public MCP endpoints are required between the client and server.

## Future Work

### Asynchronous MCP Tool Execution

SEPT already supports durable offline event delivery, allowing events to be stored and delivered when a disconnected device comes back online.

However, MCP tool calls typically follow a synchronous request/response model. If a remote MCP server is offline, the request may time out before the server becomes available, even though SEPT can still deliver it later.

A future version of SEPT-AG could bridge this gap by implementing the [MCP Tasks Extension](https://tasks.extensions.modelcontextprotocol.io/), enabling asynchronous and durable tool execution across disconnected networks.

The intended workflow would be:

1. An MCP client invokes a remote tool.
2. SEPT-AG creates a persistent task and immediately returns a task identifier.
3. The tool call is delivered through SEPT, even if the remote device is temporarily offline.
4. When the server becomes available, SEPT-AG forwards the request to the underlying MCP server.
5. The result is delivered back through SEPT and associated with the original task.
6. The MCP client retrieves the result using `tasks/get` or receives an optional `notifications/tasks` update.

This would require implementing task persistence, request/result correlation, execution deduplication, expiration policies, and cancellation handling.

Importantly, **existing MCP servers would not need to support asynchronous execution themselves**. SEPT-AG would manage the task lifecycle transparently, while the underlying MCP server continues to handle ordinary tool calls.

Agents supporting the MCP Tasks Extension could then submit operations without maintaining a continuous connection or waiting synchronously for the result.

The goal is to enable **durable asynchronous MCP tool execution across disconnected networks**, combining SEPT's offline delivery with MCP's task lifecycle.

This functionality is not yet implemented in SEPT-AG.

## Status

This project is currently an experimental prototype / demo and is not published on npm yet.

SEPT itself is available as the `@sept-protocol/*` packages on npm.

## Related

- [SEPT](https://github.com/fcavallarin/sept)
