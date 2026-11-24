// functions/api/examiners.ts  →  GET|POST|PUT|DELETE /api/examiners
import { getDb, json, error, parseBody, getQuery } from '../_db.js';
import { examiners, blockedDates, systemSettings } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { applyExaminerSelfRotationUpdate, sanitizeAdminExaminerRotationAvailability } from '../_examiner-self-rotation.js';

import { isD1 } from '../_d1.js';

let _examinersSchemaReady = false;

async function ensureSchema(db: any) {
  if (isD1(db) || _examinersSchemaReady) return;
  try {
    await db.execute(sql`ALTER TABLE public.examinadores ADD COLUMN IF NOT EXISTS categorias jsonb DEFAULT '[]'::jsonb`);
    await db.execute(sql`ALTER TABLE public.examinadores ADD COLUMN IF NOT EXISTS max_vagas_a_padrao integer`);
    await db.execute(sql`ALTER TABLE public.examinadores ADD COLUMN IF NOT EXISTS max_vagas_b_padrao integer`);
    await db.execute(sql`ALTER TABLE public.examinadores ADD COLUMN IF NOT EXISTS max_vagas_mudanca_padrao integer`);
    await db.execute(sql`ALTER TABLE public.examinadores ADD COLUMN IF NOT EXISTS rodizio_provas boolean NOT NULL DEFAULT false`);
    await db.execute(sql`ALTER TABLE public.examinadores ADD COLUMN IF NOT EXISTS disponibilidade_rodizio jsonb`);
    await db.execute(sql`ALTER TABLE public.examinadores ADD COLUMN IF NOT EXISTS periodos_bloqueio jsonb DEFAULT '[]'::jsonb`);
    _examinersSchemaReady = true;
  } catch {}
}

export const onRequest: PagesFunction<{ DATABASE_URL: string }> = async ({ request, env, data }) => {
  try {
    const db = getDb(env as any);
    const method = request.method;
    const query = getQuery(request.url);

    if (method === 'GET') {
      await ensureSchema(db);
      const rows = await db.select().from(examiners);
      // Normalise nullable JSONB fields that may be null in older rows
      const normalised = rows.map((r: any) => ({
        ...r,
        blockedPeriods: Array.isArray(r.blockedPeriods) ? r.blockedPeriods : [],
        categories: Array.isArray(r.categories) ? r.categories : [],
      }));
      return json(normalised);
    }

    if (method === 'POST') {
      if ((data as any)?.authorizedRoute !== 'examiners') return error('Acesso negado.', 403);
      await ensureSchema(db);
      const body = await parseBody<any>(request);
      if (Object.hasOwn(body, 'rotationAvailability')) {
        body.rotationAvailability = sanitizeAdminExaminerRotationAvailability(body.rotationAvailability);
      }
      const newItem = await db.insert(examiners).values({ id: crypto.randomUUID(), ...body }).returning();
      return json(newItem[0]);
    }

    if (method === 'PUT') {
      if ((data as any)?.authorizedRoute !== 'examiners') return error('Acesso negado.', 403);
      await ensureSchema(db);
      const body = await parseBody<any>(request);
      const sessionRole = (data as any)?.sessionUserRole;
      const sessionExaminerId = (data as any)?.sessionUser?.examinerId;
      if (sessionRole === 'EXAMINER') {
        if (!sessionExaminerId || body?.id !== sessionExaminerId) {
          return error('Acesso negado.', 403);
        }
        const res = await applyExaminerSelfRotationUpdate(
          db,
          { examiners, blockedDates, systemSettings },
          sessionExaminerId,
          body.rotationAvailability,
        );
        if (res.error) return error(res.error, res.status);
        return json(res.updated);
      }
      const { id, createdAt, updatedAt, ...updates } = body;
      if (Object.hasOwn(updates, 'rotationAvailability')) {
        const [stored] = await db.select().from(examiners).where(eq(examiners.id, id)).limit(1);
        updates.rotationAvailability = sanitizeAdminExaminerRotationAvailability(
          updates.rotationAvailability,
          stored?.rotationAvailability,
        );
      }
      const updated = await db.update(examiners).set(updates).where(eq(examiners.id, id)).returning();
      return json(updated[0]);
    }

    if (method === 'DELETE') {
      if ((data as any)?.authorizedRoute !== 'examiners') return error('Acesso negado.', 403);
      const id = query.id;
      if (!id) return error('ID obrigatório', 400);
      await db.delete(examiners).where(eq(examiners.id, id));
      return json({ success: true });
    }

    return error('Method Not Allowed', 405);
  } catch (e: any) {
    return error(e.message ?? 'Erro interno', 500);
  }
};
