// 128-bit random id, base64url encoded (22 chars)
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{22}$/;

export function newSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

// Workspace, project and share ids share the format
export const isId = isSessionId;
export const newId = newSessionId;
