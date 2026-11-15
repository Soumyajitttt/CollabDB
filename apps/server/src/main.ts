import "dotenv/config";
import { loadConfig } from "./config";
import { startServer } from "./server";

(async () => {
  const config = loadConfig();
  const server = await startServer(config, (m) => console.log(`[server] ${m}`));
  console.log(`[server] listening on ${server.url} (accepting web origin ${config.WEB_ORIGIN})`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("[server] shutting down, flushing pending writes...");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
