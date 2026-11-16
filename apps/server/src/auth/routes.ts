import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { ZodError } from "zod";
import {
  AddMemberBody, CreateDocBody, DocIdParam, DocSummary, LoginBody, MemberInfo, PublicUser, RegisterBody,
  UpdateMemberBody, verifyAccessToken,
} from "@collab/shared";
import type { Config } from "../config";
import { RateLimiter } from "../rateLimiter";
import { checkPassword, hashPassword } from "./password";

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
  }
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function authRouter(pool: Pool, config: Config): Router {
  const r = Router();
  const limiter = new RateLimiter(config.AUTH_RATE_BURST, config.AUTH_RATE_PER_SEC);

  r.use((req, res, next) => {
    if (!limiter.consume(req.ip ?? "unknown")) return void res.status(429).json({ error: "RATE_LIMITED" });
    next();
  });

  r.post("/register", wrap(async (req, res) => {
    const body = RegisterBody.parse(req.body);
    const hash = await hashPassword(body.password, config.BCRYPT_COST);
    try {
      const { rows } = await pool.query<PublicUser>(
        "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name",
        [body.email, hash, body.name],
      );
      res.status(201).json({ user: rows[0] });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return void res.status(409).json({ error: "EMAIL_TAKEN" });
      throw e;
    }
  }));

  /** Checks credentials only. NextAuth turns the result into a session. */
  r.post("/login", wrap(async (req, res) => {
    const body = LoginBody.parse(req.body);
    const { rows } = await pool.query<PublicUser & { password_hash: string }>(
      "SELECT id, email, name, password_hash FROM users WHERE email = $1",
      [body.email],
    );
    const u = rows[0];
    if (!(await checkPassword(body.password, u?.password_hash)) || !u) {
      return void res.status(401).json({ error: "INVALID_CREDENTIALS" });
    }
    res.json({ user: { id: u.id, email: u.email, name: u.name } satisfies PublicUser });
  }));

  return r;
}

export function requireAuth(config: Config) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!m) return void res.status(401).json({ error: "UNAUTHORIZED" });
    try {
      req.userId = (await verifyAccessToken(config.JWT_SECRET, m[1]!)).sub;
      next();
    } catch {
      res.status(401).json({ error: "UNAUTHORIZED" });
    }
  };
}

type Role = "owner" | "editor" | "viewer";

export function docsRouter(
  pool: Pool,
  config: Config,
  /** Called after any membership change so connected sockets pick up the new role at once. */
  onMembershipChanged: (docId: string, userId: string) => Promise<void> = async () => {},
): Router {
  const r = Router();
  r.use(requireAuth(config));

  const roleOf = async (docId: string, userId: string): Promise<Role | null> =>
    (await pool.query<{ role: Role }>("SELECT role FROM document_members WHERE doc_id = $1 AND user_id = $2", [docId, userId])).rows[0]?.role ?? null;

  r.get("/", wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT d.id, d.name, m.role, d.created_at AS "createdAt"
         FROM documents d JOIN document_members m ON m.doc_id = d.id
        WHERE m.user_id = $1 ORDER BY d.created_at DESC`,
      [req.userId],
    );
    res.json({ docs: rows satisfies DocSummary[] });
  }));

  r.post("/", wrap(async (req, res) => {
    const { name } = CreateDocBody.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const d = await client.query<{ id: string; created_at: Date }>(
        "INSERT INTO documents (name, owner_id) VALUES ($1, $2) RETURNING id, created_at",
        [name, req.userId],
      );
      await client.query("INSERT INTO document_members (doc_id, user_id, role) VALUES ($1, $2, 'owner')", [
        d.rows[0]!.id, req.userId,
      ]);
      await client.query("COMMIT");
      res.status(201).json({ doc: { id: d.rows[0]!.id, name, role: "owner", createdAt: d.rows[0]!.created_at } });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }));

  // ---- sharing ----
  // Non-members get 404 (not 403) so the existence of a document is not revealed.

  r.get("/:id/members", wrap(async (req, res) => {
    const docId = DocIdParam.parse(req.params.id);
    if (!(await roleOf(docId, req.userId!))) return void res.status(404).json({ error: "NOT_FOUND" });
    const { rows } = await pool.query<MemberInfo>(
      `SELECT u.id AS "userId", u.email, u.name, m.role
         FROM document_members m JOIN users u ON u.id = m.user_id
        WHERE m.doc_id = $1
        ORDER BY (m.role = 'owner') DESC, u.name`,
      [docId],
    );
    res.json({ members: rows });
  }));

  r.post("/:id/members", wrap(async (req, res) => {
    const docId = DocIdParam.parse(req.params.id);
    const me = await roleOf(docId, req.userId!);
    if (!me) return void res.status(404).json({ error: "NOT_FOUND" });
    if (me !== "owner") return void res.status(403).json({ error: "FORBIDDEN" });
    const body = AddMemberBody.parse(req.body);
    const u = await pool.query<{ id: string; name: string; email: string }>("SELECT id, name, email FROM users WHERE email = $1", [body.email]);
    const target = u.rows[0];
    if (!target) return void res.status(404).json({ error: "USER_NOT_FOUND" });
    if ((await roleOf(docId, target.id)) === "owner") return void res.status(409).json({ error: "ALREADY_OWNER" });
    await pool.query(
      `INSERT INTO document_members (doc_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (doc_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [docId, target.id, body.role],
    );
    await onMembershipChanged(docId, target.id);
    res.status(201).json({ member: { userId: target.id, email: target.email, name: target.name, role: body.role } satisfies MemberInfo });
  }));

  r.patch("/:id/members/:userId", wrap(async (req, res) => {
    const docId = DocIdParam.parse(req.params.id);
    const targetId = DocIdParam.parse(req.params.userId);
    const me = await roleOf(docId, req.userId!);
    if (!me) return void res.status(404).json({ error: "NOT_FOUND" });
    if (me !== "owner") return void res.status(403).json({ error: "FORBIDDEN" });
    const { role } = UpdateMemberBody.parse(req.body);
    const current = await roleOf(docId, targetId);
    if (!current) return void res.status(404).json({ error: "NOT_FOUND" });
    if (current === "owner") return void res.status(409).json({ error: "CANNOT_CHANGE_OWNER" });
    await pool.query("UPDATE document_members SET role = $3 WHERE doc_id = $1 AND user_id = $2", [docId, targetId, role]);
    await onMembershipChanged(docId, targetId);
    res.json({ ok: true });
  }));

  r.delete("/:id/members/:userId", wrap(async (req, res) => {
    const docId = DocIdParam.parse(req.params.id);
    const targetId = DocIdParam.parse(req.params.userId);
    const me = await roleOf(docId, req.userId!);
    if (!me) return void res.status(404).json({ error: "NOT_FOUND" });
    // The owner can remove anyone; everyone else can only remove themselves (leave).
    if (me !== "owner" && targetId !== req.userId) return void res.status(403).json({ error: "FORBIDDEN" });
    const current = await roleOf(docId, targetId);
    if (!current) return void res.status(404).json({ error: "NOT_FOUND" });
    if (current === "owner") return void res.status(409).json({ error: "CANNOT_REMOVE_OWNER" });
    await pool.query("DELETE FROM document_members WHERE doc_id = $1 AND user_id = $2", [docId, targetId]);
    await onMembershipChanged(docId, targetId);
    res.json({ ok: true });
  }));

  return r;
}

/** Zod errors -> 400, everything else -> 500 without leaking details. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return void res.status(400).json({ error: "BAD_REQUEST", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  if ((err as { type?: string })?.type === "entity.parse.failed") return void res.status(400).json({ error: "BAD_REQUEST" });
  console.error("unhandled error:", (err as Error)?.message);
  res.status(500).json({ error: "INTERNAL" });
}
