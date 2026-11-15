// functions/api/health.ts  →  GET /api/health
export const onRequestGet: PagesFunction<{ RESEND_API_KEY?: string; DATABASE_URL?: string; DB_PROVIDER?: string; DB?: { prepare?: unknown } }> = async ({ env }) => {
  const provider = String(env.DB_PROVIDER ?? '').trim().toLowerCase() === 'd1' ? 'd1' : 'neon';
  const d1Bound = Boolean(env.DB?.prepare);
  return new Response(JSON.stringify({
    status: 'ok',
    runtime: 'cloudflare-pages',
    dbProvider: provider,
    d1Bound,
    emailConfigured: Boolean(env.RESEND_API_KEY),
    databaseConfigured: provider === 'd1' ? d1Bound : Boolean(env.DATABASE_URL),
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
