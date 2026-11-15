import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import apiApp from "./artifacts/api-server/src/app";
import { runMigrations } from "./artifacts/api-server/src/index";
import { ensureInMemoryBaseSchema, seedInMemoryDefaults } from "./artifacts/api-server/src/bootstrap";
import { logger } from "./artifacts/api-server/src/lib/logger";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";

async function startServer() {
  await ensureInMemoryBaseSchema();
  await runMigrations();
  await seedInMemoryDefaults();

  const serverApp = express();
  serverApp.use(apiApp);

  if (!isProduction) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      configFile: path.resolve(__dirname, "artifacts/praticosys/vite.config.ts"),
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: "spa",
    });
    serverApp.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "artifacts/praticosys/dist/public");
    serverApp.use(express.static(distDir));
    serverApp.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  serverApp.listen(PORT, "0.0.0.0", () => {
    logger.info({ port: PORT, mode: isProduction ? "production" : "development" }, "PráticoSys server listening");
  });
}

startServer().catch((err) => {
  logger.error({ err }, "Failed to start PráticoSys server");
  process.exit(1);
});
