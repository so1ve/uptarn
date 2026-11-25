import type { LoadedConfig } from "../config.ts";
import type { SqlDatabase } from "../db/index.ts";
import { sha256Hex, timingSafeEqualText } from "./crypto.ts";
import { checkAdminAuthRequest } from "./session.ts";

const NODE_ID_RE = /^[a-z0-9][\w.:-]{0,63}$/i;

export const publicNodeKey = async (nodeId: string): Promise<string> =>
  `n_${(await sha256Hex(nodeId)).slice(0, 8)}`;

export interface AuthenticatedLiveAgent {
  nodeId: string;
  publicKey: string;
  isPublic: boolean;
}

export async function authenticateLiveAgent(
  db: SqlDatabase,
  request: Request,
): Promise<AuthenticatedLiveAgent | null> {
  const url = new URL(request.url);
  const nodeId = url.searchParams.get("node_id")?.trim() ?? "";
  if (!NODE_ID_RE.test(nodeId)) {
    return null;
  }
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!token) {
    return null;
  }

  const [incomingHash, row] = await Promise.all([
    sha256Hex(token),
    db.first<{ token_hash: string; is_public: number }>(
      "SELECT token_hash, is_public FROM nodes WHERE id = ?1",
      [nodeId],
    ),
  ]);
  if (!row || !(await timingSafeEqualText(incomingHash, row.token_hash))) {
    return null;
  }

  return {
    nodeId,
    publicKey: await publicNodeKey(nodeId),
    isPublic: row.is_public === 1,
  };
}

export const authenticateLiveViewer = async (
  db: SqlDatabase,
  config: LoadedConfig,
  request: Request,
): Promise<"admin" | "public"> =>
  (await checkAdminAuthRequest(request, db, config)) ? "admin" : "public";
