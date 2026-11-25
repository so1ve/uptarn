import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";

import {
  authenticateLiveAgent,
  authenticateLiveViewer,
} from "../auth/index.ts";
import type { LoadedConfig } from "../config.ts";
import type { SqlDatabase } from "../db/index.ts";
import {
  LiveStateBuffer,
  MAX_LIVE_FRAME_BYTES,
  parseLiveIngestFrame,
  unixNow,
} from "../shared/index.ts";

function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (Array.isArray(val)) {
      headers.set(key, val.join(", "));
    } else if (val !== undefined) {
      headers.set(key, val);
    }
  }
  const host = req.headers.host ?? "127.0.0.1";

  return new Request(`http://${host}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
  });
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function rawDataToString(data: RawData): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
}

function sendSafe(ws: WebSocket, payload: string): void {
  if (ws.readyState !== ws.OPEN) {
    return;
  }
  try {
    ws.send(payload);
  } catch {
    ws.terminate();
  }
}

interface AgentMeta {
  nodeId: string;
  publicKey: string;
  isPublic: boolean;
}

export class NodeLiveHub {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_LIVE_FRAME_BYTES,
  });

  private readonly buffer = new LiveStateBuffer();
  private readonly agentSockets = new Map<
    string,
    { ws: WebSocket; meta: AgentMeta }
  >();

  private readonly adminViewers = new Set<WebSocket>();
  private readonly publicViewers = new Set<WebSocket>();

  public async handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    db: SqlDatabase,
    config: LoadedConfig,
  ): Promise<void> {
    const webReq = toWebRequest(req);
    const { pathname } = new URL(webReq.url);

    if (pathname === "/api/v1/ingest/live") {
      const auth = await authenticateLiveAgent(db, webReq);
      if (!auth) {
        rejectUpgrade(socket, 401, "Unauthorized");

        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.attachAgent(ws, auth);
      });

      return;
    }

    if (pathname === "/api/v1/live") {
      const scope = await authenticateLiveViewer(db, config, webReq);
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.attachViewer(ws, scope);
      });

      return;
    }

    rejectUpgrade(socket, 404, "Not Found");
  }

  private attachAgent(ws: WebSocket, meta: AgentMeta): void {
    const prev = this.agentSockets.get(meta.nodeId);
    if (prev) {
      prev.ws.close(1000, "replaced");
    }
    const entry = { ws, meta };
    this.agentSockets.set(meta.nodeId, entry);

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      const text = rawDataToString(data);
      if (!text) {
        return;
      }
      if (text === "ping") {
        ws.send("pong");

        return;
      }
      const frame = parseLiveIngestFrame(text);
      if (!frame) {
        return;
      }
      const tick = this.buffer.ingest(
        entry.meta.nodeId,
        entry.meta.publicKey,
        entry.meta.isPublic,
        frame,
        unixNow(),
      );
      if (!tick) {
        return;
      }
      if (this.adminViewers.size > 0) {
        const payload = JSON.stringify({ type: "tick", sample: tick.admin });
        for (const viewer of this.adminViewers) {
          sendSafe(viewer, payload);
        }
      }
      if (entry.meta.isPublic && tick.pub && this.publicViewers.size > 0) {
        const payload = JSON.stringify({ type: "tick", sample: tick.pub });
        for (const viewer of this.publicViewers) {
          sendSafe(viewer, payload);
        }
      }
    });

    const sockets = this.agentSockets;
    function detach() {
      if (sockets.get(meta.nodeId)?.ws === ws) {
        sockets.delete(meta.nodeId);
      }
    }
    ws.on("close", detach);
    ws.on("error", detach);
  }

  private attachViewer(ws: WebSocket, scope: "admin" | "public"): void {
    const set = scope === "admin" ? this.adminViewers : this.publicViewers;
    set.add(ws);

    ws.on("message", (data, isBinary) => {
      if (!isBinary && rawDataToString(data) === "ping") {
        ws.send("pong");
      }
    });

    const detach = () => {
      set.delete(ws);
    };
    ws.on("close", detach);
    ws.on("error", detach);

    const now = unixNow();
    const initMsg =
      scope === "admin"
        ? this.buffer.adminInitPayload(now)
        : this.buffer.publicInitPayload(now);
    sendSafe(ws, JSON.stringify(initMsg));
  }

  public setNodeVisibility(
    nodeId: string,
    publicKey: string,
    isPublic: boolean,
  ): void {
    this.buffer.setNodeVisibility(nodeId, publicKey, isPublic);
    const active = this.agentSockets.get(nodeId);
    if (active) {
      active.meta = { nodeId, publicKey, isPublic };
    }
  }

  public removeNode(nodeId: string): void {
    this.buffer.removeNode(nodeId);
    const active = this.agentSockets.get(nodeId);
    if (active) {
      active.ws.close(1000, "node deleted");
      this.agentSockets.delete(nodeId);
    }
  }

  public close(): void {
    for (const { ws } of this.agentSockets.values()) {
      ws.terminate();
    }
    for (const ws of this.adminViewers) {
      ws.terminate();
    }
    for (const ws of this.publicViewers) {
      ws.terminate();
    }
    this.agentSockets.clear();
    this.adminViewers.clear();
    this.publicViewers.clear();
    this.wss.close();
  }
}
