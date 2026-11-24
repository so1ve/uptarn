import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Context } from "hono";

import type { LoadedConfig } from "../config.ts";
import type { SqlDatabase } from "../db/index.ts";
import { errorMessage, httpError, readJson } from "../http.ts";
import { unixNow } from "../shared/index.ts";
import { fromBase64Url, toBase64Url } from "./crypto.ts";
import {
  createAdminSession,
  hasPasswordLogin,
  resolveRpOrigin,
} from "./session.ts";

const encoder = new TextEncoder();
const CHALLENGE_TTL_SECS = 300;

const parseTransports = (json: string): AuthenticatorTransportFuture[] =>
  JSON.parse(json) as AuthenticatorTransportFuture[];

async function loadCredentialDescriptors(db: SqlDatabase) {
  const rows = await db.all<{ id: string; transports_json: string }>(
    "SELECT id, transports_json FROM admin_passkeys",
  );

  return rows.map((pk) => ({
    id: pk.id,
    transports: parseTransports(pk.transports_json),
  }));
}

async function issueChallenge(
  db: SqlDatabase,
  purpose: "login" | "register",
  challenge: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.run(
    "INSERT INTO webauthn_challenges (id, purpose, challenge, expires_at) VALUES (?1, ?2, ?3, ?4)",
    [id, purpose, challenge, unixNow() + CHALLENGE_TTL_SECS],
  );

  return id;
}

async function consumeChallenge(
  db: SqlDatabase,
  challengeId: string,
  purpose: "login" | "register",
  now: number,
): Promise<string> {
  const row = await db.first<{
    purpose: string;
    challenge: string;
    expires_at: number;
  }>(
    "DELETE FROM webauthn_challenges WHERE id = ?1 RETURNING purpose, challenge, expires_at",
    [challengeId],
  );
  if (row?.purpose !== purpose || row.expires_at <= now) {
    throw httpError(400, "Passkey challenge expired, try again");
  }

  return row.challenge;
}

export async function handlePasskeyLoginOptions(
  c: Context,
  db: SqlDatabase,
  config: LoadedConfig,
): Promise<Response> {
  const { rpID } = resolveRpOrigin(c, config);
  const allowCredentials = await loadCredentialDescriptors(db);
  if (allowCredentials.length === 0) {
    throw httpError(400, "No passkeys registered yet");
  }

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
    allowCredentials,
  });
  const challengeId = await issueChallenge(db, "login", options.challenge);

  return c.json({ challenge_id: challengeId, options });
}

export async function handlePasskeyLoginVerify(
  c: Context,
  db: SqlDatabase,
  config: LoadedConfig,
): Promise<Response> {
  const { rpID, origin } = resolveRpOrigin(c, config);
  const now = unixNow();

  const body = await readJson<{
    challenge_id?: string;
    response?: AuthenticationResponseJSON;
  }>(c);
  if (!body.challenge_id || !body.response?.id) {
    throw httpError(400, "Missing challenge_id or response");
  }

  const [expectedChallenge, passkey] = await Promise.all([
    consumeChallenge(db, body.challenge_id, "login", now),
    db.first<{
      id: string;
      public_key: string;
      counter: number;
      transports_json: string;
    }>(
      "SELECT id, public_key, counter, transports_json FROM admin_passkeys WHERE id = ?1",
      [body.response.id],
    ),
  ]);
  if (!passkey) {
    throw httpError(401, "Unknown passkey credential");
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: passkey.id,
        publicKey: fromBase64Url(passkey.public_key),
        counter: passkey.counter,
        transports: parseTransports(passkey.transports_json),
      },
    });
  } catch (error) {
    throw httpError(401, errorMessage(error));
  }
  if (!verification.verified) {
    throw httpError(401, "Passkey verification failed");
  }

  await db.run(
    "UPDATE admin_passkeys SET counter = ?1, last_used_at = ?2 WHERE id = ?3",
    [verification.authenticationInfo.newCounter, now, passkey.id],
  );
  await createAdminSession(c, db, config);

  return c.json({ ok: true });
}

export async function handlePasskeyRegisterOptions(
  c: Context,
  db: SqlDatabase,
  config: LoadedConfig,
): Promise<Response> {
  const { rpID } = resolveRpOrigin(c, config);
  const excludeCredentials = await loadCredentialDescriptors(db);

  const options = await generateRegistrationOptions({
    rpName: "Uptarn",
    rpID,
    userID: encoder.encode("uptarn-admin"),
    userName: "admin",
    userDisplayName: "Uptarn Admin",
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    excludeCredentials,
  });
  const challengeId = await issueChallenge(db, "register", options.challenge);

  return c.json({ challenge_id: challengeId, options });
}

export async function handlePasskeyRegisterVerify(
  c: Context,
  db: SqlDatabase,
  config: LoadedConfig,
): Promise<Response> {
  const { rpID, origin } = resolveRpOrigin(c, config);
  const now = unixNow();

  const body = await readJson<{
    challenge_id?: string;
    name?: string;
    response?: RegistrationResponseJSON;
  }>(c);
  if (!body.challenge_id || !body.response) {
    throw httpError(400, "Missing challenge_id or response");
  }

  const expectedChallenge = await consumeChallenge(
    db,
    body.challenge_id,
    "register",
    now,
  );

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch (error) {
    throw httpError(400, errorMessage(error));
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw httpError(400, "Passkey registration failed");
  }

  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;
  await db.run(
    `INSERT INTO admin_passkeys
     (id, name, public_key, counter, transports_json, device_type, backed_up, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    [
      credential.id,
      (body.name?.trim() || "Passkey").slice(0, 64),
      toBase64Url(credential.publicKey),
      credential.counter,
      JSON.stringify(body.response.response.transports ?? []),
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      now,
    ],
  );

  return c.json({ ok: true });
}

export async function handleDeletePasskey(
  c: Context,
  db: SqlDatabase,
  config: LoadedConfig,
): Promise<Response> {
  if (!hasPasswordLogin(config) && config.cfAccess === null) {
    const countRow = await db.first<{ count: number }>(
      "SELECT COUNT(*) AS count FROM admin_passkeys",
    );
    if ((countRow?.count ?? 0) <= 1) {
      throw httpError(400, "Cannot remove the only sign-in method");
    }
  }
  const res = await db.run("DELETE FROM admin_passkeys WHERE id = ?1", [
    c.req.param("id")!,
  ]);
  if (res.changes === 0) {
    throw httpError(404, "Passkey not found");
  }

  return c.json({ ok: true });
}
