import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { MAX_BUFFER_BYTES } from "@collab/shared";
import { authRouter, docsRouter, errorHandler } from "./auth/routes";
import type { Config } from "./config";
import { createPool } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { DocManager } from "./docs/DocManager";
import { attachSocket } from "./socket";

export interface RunningServer {
  url: string;
  port: number;
  pool: ReturnType<typeof createPool>;
  docManager: DocManager;
  /** Flushes pending writes, then stops everything. */
  close: () => Promise<void>;
}

export async function startServer(config: Config, log: (m: string) => void = () => {}): Promise<RunningServer> {
  const pool = createPool(config.DATABASE_URL);
  const applied = await runMigrations(pool);
  if (applied.length) log(`migrations applied: ${applied.join(", ")}`);

  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: config.WEB_ORIGIN }));
  app.use(express.json({ limit: "100kb" }));
  app.get("/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  });
  app.use("/auth", authRouter(pool, config));
  app.use("/docs", docsRouter(pool, config));
  app.use(errorHandler);

  const http = createServer(app);
  const io = new Server(http, {
    cors: { origin: config.WEB_ORIGIN },
    maxHttpBufferSize: MAX_BUFFER_BYTES,
  });
  const docManager = new DocManager(pool, { flushMs: config.FLUSH_MS, evictAfterMs: config.EVICT_AFTER_MS, log });
  attachSocket(io, { pool, config, docManager });

  await new Promise<void>((resolve) => http.listen(config.PORT, resolve));
  const port = (http.address() as AddressInfo).port;

  let closed = false;
  return {
    url: `http://localhost:${port}`,
    port,
    pool,
    docManager,
    close: async () => {
      if (closed) return;
      closed = true;
      await docManager.shutdown();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await pool.end();
    },
  };
}
