// functions/api/instructors.ts  →  GET|POST|PUT|DELETE /api/instructors
import { getDb, json, error, parseBody, getQuery } from '../_db.js';
import { hasD1CpfHmac } from '../_d1.js';
import { instructors, vehicles, users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../_password.js';
import { decryptInstructorPiiSafe, encryptInstructorPii } from '../../db/pii-crypto.js';

export const onRequest: PagesFunction<{ DATABASE_URL: string }> = async ({ request, env }) => {
  try {
    const db = getDb(env as any);
    const method = request.method;
    const query = getQuery(request.url);

    // Colunas garantidas pelo middleware (ensureColumnMigrations)

    if (method === 'GET') {
      const allInstructors = await db.select().from(instructors);
      const allVehicles = await db.select().from(vehicles);
      const data = await Promise.all(allInstructors.map(async (inst: any) => ({
        ...(await decryptInstructorPiiSafe(inst, env as any)),
        vehicles: allVehicles.filter((v: any) => v.instructorId === inst.id),
      })));
      return json(data);
    }

    if (method === 'POST') {
      const body = await parseBody<any>(request);
      const { vehicles: vehiclesList, ...instructorData } = body;
      const newId = crypto.randomUUID();
      const includeCpfHmac = await hasD1CpfHmac(db, 'instrutores');
      const encryptedData = await encryptInstructorPii(instructorData, env as any, { includeCpfHmac });
      const newItem = await db.insert(instructors).values({ id: newId, ...encryptedData }).returning();
      const decryptedItem = await decryptInstructorPiiSafe(newItem[0], env as any);
      let temporaryCredential: { login: string; password: string } | undefined;
      if (instructorData.cpf) {
        const login = instructorData.cpf.replace(/\D/g, '');
        if (login) {
          const password = crypto.randomUUID();
          const created = await db.insert(users).values({
            id: crypto.randomUUID(), name: instructorData.name, login,
            password: await hashPassword(password), forcePasswordChange: true,
            role: 'INSTRUCTOR', instructorId: newId,
          }).onConflictDoNothing().returning({ id: users.id });
          if (created.length) temporaryCredential = { login, password };
        }
      }

      if (Array.isArray(vehiclesList)) {
        for (const v of vehiclesList) {
          await db.insert(vehicles).values({
            id: crypto.randomUUID(), instructorId: newId, type: v.type, brand: v.brand,
            model: v.model, plate: v.plate, active: v.active ?? true,
            transmission: v.transmission, accessories: v.accessories || [],
            duploComando: v.duploComando ?? false,
            procuracao: v.procuracao ?? false,
            anoFabricacao: v.anoFabricacao || null,
          });
        }
      }
      return json({ ...decryptedItem, vehicles: vehiclesList || [], ...(temporaryCredential ? { temporaryCredential } : {}) });
    }

    if (method === 'PUT') {
      const body = await parseBody<any>(request);
      const { id, vehicles: vehiclesList, createdAt, updatedAt, ...updates } = body;
      const includeCpfHmac = await hasD1CpfHmac(db, 'instrutores');
      const encryptedUpdates = await encryptInstructorPii(updates, env as any, { includeCpfHmac });
      const updated = await db.update(instructors).set(encryptedUpdates).where(eq(instructors.id, id)).returning();
      const decryptedUpdated = await decryptInstructorPiiSafe(updated[0], env as any);

      if (Array.isArray(vehiclesList)) {
        await db.delete(vehicles).where(eq(vehicles.instructorId, id));
        for (const v of vehiclesList) {
          await db.insert(vehicles).values({
            id: (!v.id || v.id.startsWith('temp_')) ? crypto.randomUUID() : v.id,
            instructorId: id, type: v.type, brand: v.brand, model: v.model,
            plate: v.plate, active: v.active ?? true, transmission: v.transmission,
            accessories: v.accessories || [],
            duploComando: v.duploComando ?? false,
            procuracao: v.procuracao ?? false,
            anoFabricacao: v.anoFabricacao || null,
          });
        }
      }
      return json({ ...decryptedUpdated, vehicles: vehiclesList || [] });
    }

    if (method === 'DELETE') {
      const id = query.id;
      if (!id) return error('ID obrigatório', 400);
      await db.delete(vehicles).where(eq(vehicles.instructorId, id));
      await db.delete(instructors).where(eq(instructors.id, id));
      return json({ success: true });
    }

    return error('Method Not Allowed', 405);
  } catch (e: any) {
    return error(e.message ?? 'Erro interno', 500);
  }
};
