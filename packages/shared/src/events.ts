import { z } from "zod";
import { MAX_STATE_VECTOR_BYTES, MAX_UPDATE_BYTES, ROLES } from "./constants";

/** Event names (see docs/protocol.md). */
export const EV = {
  DOC_JOIN: "doc:join",
  DOC_JOINED: "doc:joined",
  DOC_ERROR: "doc:error",
  SYNC_STEP1: "sync:step1",
  SYNC_STEP2: "sync:step2",
  SYNC_REQUEST: "sync:request",
  SYNC_UPDATE: "sync:update",
  SYNC_ACK: "sync:ack",
} as const;

export const ErrorCode = z.enum([
  "BAD_PAYLOAD", "UNAUTHORIZED", "FORBIDDEN", "NOT_JOINED", "READ_ONLY", "RATE_LIMITED", "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

const bytes = (max: number) => z.instanceof(Uint8Array).refine((b) => b.byteLength <= max, "too large");

export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

export const JoinDoc = z.object({ docId: z.string().uuid() });
export const SyncStep1 = z.object({ docId: z.string().uuid(), stateVector: bytes(MAX_STATE_VECTOR_BYTES) });
export const SyncUpdate = z.object({
  docId: z.string().uuid(),
  update: bytes(MAX_UPDATE_BYTES),
  clientSeq: z.number().int().nonnegative(),
});

export type JoinDocPayload = z.infer<typeof JoinDoc>;
export type SyncStep1Payload = z.infer<typeof SyncStep1>;
export type SyncUpdatePayload = z.infer<typeof SyncUpdate>;

/** Server -> client shapes (plain TS types, the client trusts its own server). */
export interface DocJoinedPayload { docId: string; role: Role }
export interface DocErrorPayload { code: ErrorCode; message?: string }
export interface SyncStep2Payload { docId: string; update: Uint8Array }
export interface SyncRequestPayload { docId: string; stateVector: Uint8Array }
export interface ServerUpdatePayload { docId: string; update: Uint8Array }
export interface SyncAckPayload { docId: string; clientSeq: number }

export const ColumnType = z.enum(["text", "longtext", "number", "checkbox", "select", "date"]);
export const ColumnDef = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  type: ColumnType,
  options: z.array(z.string()).optional(),
});
