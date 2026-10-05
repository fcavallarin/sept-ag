# sept-ag

`sept-ag` is an experimental bridge for connecting MCP clients and servers over [SEPT](https://github.com/fcavallarin/sept).

It uses SEPT as the transport layer between agents and MCP servers, providing encrypted connectivity without exposing the MCP server publicly and allowing per-tool authorization through SEPT ACLs.

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
sept-ag admin grant-tool cloud-agent get_door_state
```

After the grant, the MCP client can discover and call that tool. Revoking the grant removes access again.

## Status

This project is currently an experimental prototype / demo and is not published on npm yet.

SEPT itself is available as the `@sept-protocol/*` packages on npm.

## Related

- [SEPT](https://github.com/fcavallarin/sept)
