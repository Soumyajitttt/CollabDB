import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  BCRYPT_COST: z.coerce.number().int().min(4).max(14).default(10),
  /** Updates arriving within this window are merged into ONE row in `updates`. */
  FLUSH_MS: z.coerce.number().int().min(0).default(20),
  /** A doc with no clients is dropped from memory after this long. */
  EVICT_AFTER_MS: z.coerce.number().int().min(0).default(60_000),
  /** Per-socket token bucket. */
  SOCKET_RATE_BURST: z.coerce.number().int().min(1).default(120),
  SOCKET_RATE_PER_SEC: z.coerce.number().min(0.1).default(60),
  /** Per-IP token bucket for /auth/*. */
  AUTH_RATE_BURST: z.coerce.number().int().min(1).default(20),
  AUTH_RATE_PER_SEC: z.coerce.number().min(0.01).default(0.5),
});

export type Config = z.infer<typeof Env>;

/** Throws a readable error at startup if anything is missing or malformed. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
