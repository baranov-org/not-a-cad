import type { FastifyRequest } from "fastify";

const num = (name: string, def: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};

// Abuse limits; override with env
export interface Limits {
  maxSessions: number; // stored sessions
  maxSessionBytes: number; // per session sources
  maxTotalBytes: number; // all sessions
  maxConnections: number; // open browser sockets
  maxConnectionsPerIp: number;
  mcpPerMinute: number; // MCP requests per IP
  wsPerMinute: number; // socket opens per IP
  oauthPerMinute: number; // OAuth requests per IP and endpoint (client registration: a third)
}

export const limitsFromEnv = (): Limits => ({
  maxSessions: num("MAX_SESSIONS", 2000),
  maxSessionBytes: num("MAX_SESSION_BYTES", 1_000_000),
  maxTotalBytes: num("MAX_TOTAL_BYTES", 200_000_000),
  maxConnections: num("MAX_CONNECTIONS", 300),
  maxConnectionsPerIp: num("MAX_CONNECTIONS_PER_IP", 10),
  mcpPerMinute: num("MCP_PER_MINUTE", 240),
  wsPerMinute: num("WS_PER_MINUTE", 30),
  oauthPerMinute: num("OAUTH_PER_MINUTE", 60),
});

// Real client IP for per-IP limits: CF-Connecting-IP (Cloudflare), then X-Forwarded-For, then the socket.
// Run behind a proxy that sets these, or clients can choose their own IP
export function clientIp(req: FastifyRequest): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return req.ip;
}
