export class ApiError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T = Record<string, unknown>>(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data.error || `Request failed (${res.status})`,
    );
  }

  return data;
}

export async function signInWithPasskey(): Promise<void> {
  const { challenge_id, options } = await apiFetch<{
    challenge_id: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }>("/api/v1/auth/passkey/login/options", "POST");

  const cred = (await navigator.credentials.get({
    publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
  })) as PublicKeyCredential | null;
  if (!cred) {
    throw new Error("Passkey sign-in was cancelled");
  }
  await apiFetch("/api/v1/auth/passkey/login/verify", "POST", {
    challenge_id,
    response: cred.toJSON(),
  });
}

export async function registerPasskey(name: string): Promise<void> {
  const { challenge_id, options } = await apiFetch<{
    challenge_id: string;
    options: PublicKeyCredentialCreationOptionsJSON;
  }>("/api/v1/admin/passkeys/register/options", "POST");

  const cred = (await navigator.credentials.create({
    publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options),
  })) as PublicKeyCredential | null;
  if (!cred) {
    throw new Error("Passkey registration was cancelled");
  }
  await apiFetch("/api/v1/admin/passkeys/register/verify", "POST", {
    challenge_id,
    name,
    response: cred.toJSON(),
  });
}
