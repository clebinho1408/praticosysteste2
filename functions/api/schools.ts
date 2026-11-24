// functions/api/schools.ts  →  GET|POST|PUT|DELETE /api/schools
import { getDb, json, error, parseBody, getQuery } from '../_db.js';
import {
  drivingSchools,
  examSchedules,
  examiners,
  cities,
  examLocations,
  blockedDates,
  systemSettings,
  cfcScheduleSlots,
  cfcRequests,
  cnhbrasilRequests,
} from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { schoolPauseValidation } from '../_school-schedule.js';
import { cnhSchoolScaleConflict } from '../_cnh-time-conflicts.js';
import { schoolYardsValidation } from '../_school-yards.js';
import {
  mergePreservedAutoCnhBancaLinks,
  syncCnhRotationBancasOnDb,
} from '../_cnh-auto-bancas.js';
import {
  cleanupDerivedSchedulesOnSchoolDelete,
  syncDerivedSchedulesOnSchoolUpdate,
} from '../_school-sync-propagation.js';

import { isD1 } from '../_d1.js';

let _schoolsSchemaReady = false;

async function ensureSchema(db: any) {
  if (isD1(db) || _schoolsSchemaReady) return;
  try {
    await db.execute(sql`ALTER TABLE autoescolas ADD COLUMN IF NOT EXISTS email text`);
    await db.execute(sql`ALTER TABLE autoescolas ADD COLUMN IF NOT EXISTS cidade text`);
    await db.execute(sql`ALTER TABLE autoescolas ADD COLUMN IF NOT EXISTS servicos jsonb DEFAULT '[]'::jsonb`);
    await db.execute(sql`ALTER TABLE autoescolas ADD COLUMN IF NOT EXISTS endereco_patio_moto text`);
    await db.execute(sql`ALTER TABLE autoescolas ADD COLUMN IF NOT EXISTS endereco_patio_carro text`);
    await db.execute(sql`ALTER TABLE autoescolas ADD COLUMN IF NOT EXISTS endereco_patio_mudanca text`);
    await db.execute(sql`ALTER TABLE autoescolas ADD COLUMN IF NOT EXISTS banca_principal jsonb`);
    await db.execute(sql`ALTER TABLE autoescolas ADD COLUMN IF NOT EXISTS banca_provisoria jsonb`);
    await db.execute(sql`ALTER TABLE autoescolas ADD COLUMN IF NOT EXISTS nao_criar_usuario boolean NOT NULL DEFAULT false`);
    await db.execute(sql`ALTER TABLE autoescolas ADD COLUMN IF NOT EXISTS rodizio_provas boolean NOT NULL DEFAULT false`);
    await db.execute(sql`ALTER TABLE autoescolas ADD COLUMN IF NOT EXISTS perfil_cnh_brasil boolean NOT NULL DEFAULT false`);
    await db.execute(sql`ALTER TABLE autoescolas ADD COLUMN IF NOT EXISTS patios jsonb DEFAULT '[]'::jsonb`);
    _schoolsSchemaReady = true;
  } catch (e) {
    throw new Error('Não foi possível preparar o cadastro de autoescolas.', { cause: e });
  }
}

export const onRequest: PagesFunction<{ DATABASE_URL: string }> = async ({ request, env, data }) => {
  try {
    const db = getDb(env as any);
    const method = request.method;
    const query = getQuery(request.url);

    if (method === 'GET') {
      await ensureSchema(db);
      return json(await db.select().from(drivingSchools));
    }

    if (method === 'POST') {
      if ((data as any)?.authorizedRoute !== 'schools') return error('Acesso negado.', 403);
      await ensureSchema(db);
      const body = await parseBody<any>(request);
      const invalid = schoolPauseValidation(body);
      if (invalid) return error(invalid, 400);
      const invalidYards = schoolYardsValidation(body);
      if (invalidYards) return error(invalidYards, 400);
      const conflict = cnhSchoolScaleConflict({ ...body, id: undefined }, await db.select().from(drivingSchools));
      if (conflict) return error(conflict, 409);
      const newItem = await db.insert(drivingSchools).values({ id: crypto.randomUUID(), ...body }).returning();
      await syncCnhRotationBancasOnDb(db, {
        drivingSchools,
        examSchedules,
        examiners,
        cities,
        examLocations,
        blockedDates,
        systemSettings,
      });
      const refreshed = newItem[0]?.id
        ? (await db.select().from(drivingSchools).where(eq(drivingSchools.id, newItem[0].id)).limit(1))[0]
        : newItem[0];
      return json(refreshed ?? newItem[0]);
    }

    if (method === 'PUT') {
      if ((data as any)?.authorizedRoute !== 'schools') return error('Acesso negado.', 403);
      await ensureSchema(db);
      const body = await parseBody<any>(request);
      const invalid = schoolPauseValidation(body);
      if (invalid) return error(invalid, 400);
      const invalidYards = schoolYardsValidation(body);
      if (invalidYards) return error(invalidYards, 400);
      const { id, createdAt, ...updates } = body;
      const existing = await db.select().from(drivingSchools);
      const current = existing.find(school => school.id === id);
      if (!current) return error('Autoescola não encontrada.', 404);
      if (updates.mainSchedule !== undefined) {
        updates.mainSchedule = mergePreservedAutoCnhBancaLinks(updates.mainSchedule, current.mainSchedule);
      }
      const conflict = cnhSchoolScaleConflict({ ...current, ...updates, id }, existing);
      if (conflict) return error(conflict, 409);
      const updated = await db.update(drivingSchools).set(updates).where(eq(drivingSchools.id, id)).returning();
      const updatedSchool = updated[0] ?? { ...current, ...updates, id };
      await syncDerivedSchedulesOnSchoolUpdate(
        db,
        {
          drivingSchools,
          examiners,
          examSchedules,
          cfcScheduleSlots,
          cfcRequests,
          cnhbrasilRequests,
          blockedDates,
          systemSettings,
        },
        { currentSchool: current, updatedSchool },
      );
      await syncCnhRotationBancasOnDb(db, {
        drivingSchools,
        examSchedules,
        examiners,
        cities,
        examLocations,
        blockedDates,
        systemSettings,
      });
      const refreshed = (await db.select().from(drivingSchools).where(eq(drivingSchools.id, id)).limit(1))[0];
      return json(refreshed ?? updated[0]);
    }

    if (method === 'DELETE') {
      if ((data as any)?.authorizedRoute !== 'schools') return error('Acesso negado.', 403);
      const id = query.id;
      if (!id) return error('ID obrigatório', 400);
      const [existingSchool] = await db.select().from(drivingSchools).where(eq(drivingSchools.id, id)).limit(1);
      if (existingSchool) {
        await cleanupDerivedSchedulesOnSchoolDelete(
          db,
          { cfcScheduleSlots, examSchedules, cnhbrasilRequests },
          { school: existingSchool },
        );
      }
      await db.delete(drivingSchools).where(eq(drivingSchools.id, id));
      return json({ success: true });
    }

    return error('Method Not Allowed', 405);
  } catch (e: any) {
    return error(e.message ?? 'Erro interno', 500);
  }
};
