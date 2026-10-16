// MCP over SEPT.
//
// Every JSON-RPC message travels as a SEPT event. tools/call requests use a
// per-tool event type (mcp.tools.call.<name>), every other message uses
// mcp.rpc. SEPT checks the receiving device's local policy before an event is
// even stored, so granting or revoking mcp.tools.call.<name> is what allows or
// blocks each tool: the MCP layer never sees a call it is not allowed to run.

export const RPC_EVENT = "mcp.rpc"
export const toolCallEvent = name => `mcp.tools.call.${name}`

const isRequest = m => typeof m?.method === "string" && m.id !== undefined
const isInitialize = m => isRequest(m) && m.method === "initialize"

function eventTypeFor(message) {
  if (message.method === "tools/call" && typeof message.params?.name === "string") {
    return toolCallEvent(message.params.name)
  }
  return RPC_EVENT
}


// One per SeptClient: SEPT allows a single handler per event type, so the
// channel registers the MCP event types once and routes each message to the
// transport of its sender device.
export class SeptMcpChannel {
  constructor(sept, {
    logPrefix = "",
    // Requests older than this (or than the sender's own timeout) are dropped
    // on receipt: the sender has already given up on them.
    maxRequestAgeMs = 60000,
    clockSkewMs = 5000,
  } = {}) {
    this.sept = sept
    this.logPrefix = logPrefix
    this.maxRequestAgeMs = maxRequestAgeMs
    this.clockSkewMs = clockSkewMs
    this.transports = new Map()
    // Set by servers: called with a new transport when a device without a
    // session sends a message. Must connect an MCP server to it.
    this.onsession = null
    this.registerEventType(RPC_EVENT)
  }

  // Tools must be registered to be callable: an unregistered event type is
  // never delivered by SEPT.
  registerTools(names) {
    for (const name of names) {
      this.registerEventType(toolCallEvent(name))
      console.log(`${this.logPrefix}Registered ${toolCallEvent(name)}`)
    }
  }

  registerEventType(eventType) {
    this.sept.register(eventType, event => this.receive(eventType, event))
  }

  // Transport towards a remote device (client side).
  connect(deviceId, options) {
    this.transports.get(deviceId)?.close()
    const transport = new SeptTransport(this, deviceId, options)
    this.transports.set(deviceId, transport)
    return transport
  }

  async receive(eventType, event) {
    const { message, timeoutMs } = event.payload ?? {}
    if (!message || typeof message !== "object") {
      return
    }

    if (isRequest(message) && this.isStale(eventType, event, message, timeoutMs)) {
      return
    }

    let transport = this.transports.get(event.senderDeviceId)

    // A restarted client starts a new session.
    if (transport && isInitialize(message) && this.onsession) {
      await transport.close()
      transport = undefined
    }

    if (!transport) {
      if (!this.onsession) {
        console.warn(`${this.logPrefix}Ignoring ${eventType} from`, event.senderDeviceId)
        return
      }
      transport = new SeptTransport(this, event.senderDeviceId, {
        sessionId: event.senderDeviceId,
      })
      this.transports.set(event.senderDeviceId, transport)
      await this.onsession(transport)
    }

    transport.deliver(message, event)
  }

  // Returns true when a request must not be executed because the sender has
  // already given up on it, or its timestamp is implausible.
  isStale(eventType, event, message, timeoutMs) {
    const nowMs = Date.now()
    const ageMs = nowMs - event.timestamp * 1000

    const requested = Number(timeoutMs)
    const windowMs = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, this.maxRequestAgeMs)
      : this.maxRequestAgeMs

    let reason = null
    if (-ageMs > this.clockSkewMs) {
      reason = `timestamp ${Math.round(-ageMs / 1000)}s in the future`
    } else if (ageMs > windowMs - this.clockSkewMs) {
      reason = `expired (age ${Math.round(ageMs / 1000)}s, window ${Math.round(windowMs / 1000)}s)`
    }

    if (reason) {
      console.warn(
        `${this.logPrefix}Dropping ${eventType} ${message.id}`
        + ` from ${event.senderDeviceId}: ${reason}`,
      )
      return true
    }
    return false
  }
}


// MCP Transport between this device and one remote device.
export class SeptTransport {
  constructor(channel, deviceId, { requestTimeoutMs, sessionId } = {}) {
    this.channel = channel
    this.deviceId = deviceId
    // Server side only: a client transport with a sessionId makes the MCP
    // Client assume an existing session and skip the handshake.
    this.sessionId = sessionId
    this.requestTimeoutMs = requestTimeoutMs
    this.closed = false
  }

  async start() { }

  async send(message) {
    if (this.closed) {
      throw new Error("Transport closed")
    }
    const payload = { message }
    if (isRequest(message) && this.requestTimeoutMs) {
      // Lets the receiver drop the request once we've stopped waiting for it
      // (e.g. delivered after the other side was offline).
      payload.timeoutMs = this.requestTimeoutMs
    }
    await this.channel.sept.send(eventTypeFor(message), payload, [this.deviceId])
  }

  async close() {
    if (this.closed) {
      return
    }
    this.closed = true
    if (this.channel.transports.get(this.deviceId) === this) {
      this.channel.transports.delete(this.deviceId)
    }
    this.onclose?.()
  }

  deliver(message, event) {
    if (this.closed) {
      return
    }
    // The sender's identity, verified by SEPT, for MCP request handlers.
    this.onmessage?.(message, {
      authInfo: {
        token: "",
        clientId: event.senderDeviceId,
        scopes: [],
        extra: { eventId: event.eventId, timestamp: event.timestamp },
      },
    })
  }
}
