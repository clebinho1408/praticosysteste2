import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { isInMemoryDb } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    runtime: "node-express",
    emailConfigured: Boolean(process.env.RESEND_API_KEY),
    databaseConfigured: Boolean(process.env.DATA_BASE_NEON || process.env.DATABASE_URL),
    inMemoryFallback: isInMemoryDb,
    cpfLookupConfigured: Boolean(process.env.APICPF_API_KEY),
    setupSecretConfigured: Boolean(process.env.SESSION_SECRET),
  });
});

export default router;
