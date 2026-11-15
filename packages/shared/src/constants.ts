/**
 * The roadmap suggests 256 KB. We use 4 MiB because a long offline session or a bulk
 * import (the 10k-row benchmark) is ONE Yjs update and must still fit. Rate limits and
 * the Socket.IO buffer cap (MAX_BUFFER_BYTES) are what protect the server.
 */
export const MAX_UPDATE_BYTES = 4 * 1024 * 1024;
export const MAX_STATE_VECTOR_BYTES = 64 * 1024;
export const MAX_BUFFER_BYTES = 5 * 1024 * 1024;

export const TOKEN_ISSUER = "collab-db-web";
export const TOKEN_AUDIENCE = "collab-db-server";
export const TOKEN_TTL_SECONDS = 10 * 60;

export const ROLES = ["owner", "editor", "viewer"] as const;
