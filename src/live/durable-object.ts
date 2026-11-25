import { DurableObject } from "cloudflare:workers";

import {
  LiveStateBuffer,
  parseLiveIngestFrame,
  unixNow,
} from "../shared/index.ts";

type CfWebSocket = Parameters<DurableObjectState["acceptWebSocket"]>[0];

interface AgentAttachment {
  role: "agent";
  nodeId: string;
  publicKey: string;
  isPublic: boolean;
}

interface ViewerAttachment {
  role: "viewer";
  scope: "admin" | "public";
}

type SocketAttachment = AgentAttachment | ViewerAttachment;

const NODE_TAG_PREFIX = "node:";
const ADMIN_VIEWER_TAG = "viewer:admin";
const PUBLIC_VIEWER_TAG = "viewer:public";

function sendSafe(ws: CfWebSocket, payload: string): void {
  try {
    ws.send(payload);
  } catch {
    try {
      ws.close(1011, "send failed");
    } catch {
      // Ignore already closed socket
    }
  }
}

export class LiveHub extends DurableObject<unknown> {
  private readonly buffer = new LiveStateBuffer();

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    // Handle keepalive pings without waking the Durable Object from hibernation.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  public override fetch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const role = request.headers.get("X-Uptarn-Role");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [CfWebSocket, CfWebSocket];

    if (role === "agent") {
      const nodeId = request.headers.get("X-Uptarn-Node-Id");
      const publicKey = request.headers.get("X-Uptarn-Public-Key");
      if (!nodeId || !publicKey) {
        return new Response("Missing agent metadata", { status: 400 });
      }
      const isPublic = request.headers.get("X-Uptarn-Is-Public") === "1";
      const nodeTag = `${NODE_TAG_PREFIX}${nodeId}`;
      for (const stale of this.ctx.getWebSockets(nodeTag)) {
        try {
          stale.close(1000, "replaced");
        } catch {
          // Ignore already closed socket
        }
      }
      this.ctx.acceptWebSocket(server, ["agent", nodeTag]);
      server.serializeAttachment({
        role: "agent",
        nodeId,
        publicKey,
        isPublic,
      } satisfies AgentAttachment);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    if (role === "viewer") {
      const scope =
        request.headers.get("X-Uptarn-Scope") === "admin" ? "admin" : "public";
      const scopeTag = scope === "admin" ? ADMIN_VIEWER_TAG : PUBLIC_VIEWER_TAG;
      this.ctx.acceptWebSocket(server, ["viewer", scopeTag]);
      server.serializeAttachment({
        role: "viewer",
        scope,
      } satisfies ViewerAttachment);

      const now = unixNow();
      const initMsg =
        scope === "admin"
          ? this.buffer.adminInitPayload(now)
          : this.buffer.publicInitPayload(now);
      sendSafe(server, JSON.stringify(initMsg));

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response("Invalid live role", { status: 400 });
  }

  public override webSocketMessage(
    ws: CfWebSocket,
    message: string | ArrayBuffer,
  ): void {
    if (typeof message !== "string") {
      return;
    }
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.role !== "agent") {
      return;
    }
    const frame = parseLiveIngestFrame(message);
    if (!frame) {
      return;
    }

    const tick = this.buffer.ingest(
      attachment.nodeId,
      attachment.publicKey,
      attachment.isPublic,
      frame,
      unixNow(),
    );
    if (!tick) {
      return;
    }

    // Zero-viewer fast path: skip serialization and fan-out when nobody is watching.
    const adminSockets = this.ctx.getWebSockets(ADMIN_VIEWER_TAG);
    const publicSockets =
      attachment.isPublic && tick.pub
        ? this.ctx.getWebSockets(PUBLIC_VIEWER_TAG)
        : [];

    if (adminSockets.length > 0) {
      const adminPayload = JSON.stringify({
        type: "tick",
        sample: tick.admin,
      });
      for (const viewer of adminSockets) {
        sendSafe(viewer, adminPayload);
      }
    }

    if (publicSockets.length > 0 && tick.pub) {
      const publicPayload = JSON.stringify({
        type: "tick",
        sample: tick.pub,
      });
      for (const viewer of publicSockets) {
        sendSafe(viewer, publicPayload);
      }
    }
  }

  public override webSocketClose(
    ws: CfWebSocket,
    code: number,
    reason: string,
  ): void {
    try {
      ws.close(code, reason);
    } catch {
      // Ignore close errors
    }
  }

  public override webSocketError(ws: CfWebSocket): void {
    try {
      ws.close(1011, "websocket error");
    } catch {
      // Ignore close errors
    }
  }

  public setNodeVisibility(
    nodeId: string,
    publicKey: string,
    isPublic: boolean,
  ): void {
    this.buffer.setNodeVisibility(nodeId, publicKey, isPublic);
    for (const ws of this.ctx.getWebSockets(`${NODE_TAG_PREFIX}${nodeId}`)) {
      ws.serializeAttachment({
        role: "agent",
        nodeId,
        publicKey,
        isPublic,
      } satisfies AgentAttachment);
    }
  }

  public removeNode(nodeId: string): void {
    this.buffer.removeNode(nodeId);
    for (const ws of this.ctx.getWebSockets(`${NODE_TAG_PREFIX}${nodeId}`)) {
      try {
        ws.close(1000, "node deleted");
      } catch {
        // Ignore close errors
      }
    }
  }
}
