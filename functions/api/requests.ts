// functions/api/requests.ts  →  GET|POST|PUT|DELETE /api/requests
import { getDb, json, error, parseBody, getQuery, writeAuditLog, extractActor } from '../_db.js';
import { cnhbrasilRequests, cfcRequests, pcdRequests, examiners, systemSettings, blockedDates, users } from '../../db/schema.js';
import { eq, like, and, or } from 'drizzle-orm';
import { canManageConfirmed, isConfirmedCfc, confirmedAccessError, confirmedPatch, validateConfirmedEdit, hasCandidateIdentity, clearAppointment } from '../_cfc-confirmed.js';
import { extraEditError, extraPatch } from '../_cfc-extra.js';
import { interestError, interestPatch } from '../_cfc-interest.js';
import { modalityValidationError } from '../_cnh-exam-modality.js';
import { UpdateExamRequestBody } from '../../lib/api-zod/src/generated/api.js';
import { computeCpfHmac, decryptRequestPii, encryptRequestPii, maskCpf } from '../../db/pii-crypto.js';

const ALLOWED_FIELDS = [
  'id','studentName','socialName','cpf','phone','email','address','city',
  'requestType','examType','intendedCategory','source','schoolId',
  'paidFee','completedPracticalCourse','practicalHours','hasVehicle',
  'cnhRestriction','instructor','vehiclePlate','disabilityType',
  'specialNeeds','status','result','scheduleId','scheduledDate',
  'scheduledTime','scheduledCategory','examinerId','attendanceConfirmed',
  'cancellationReason','observation','categoryQuantities','examHistory',
  'queueUpdatedAt','checklistVehicle','practicalCourseInserted','taxaPaga',
  'scheduledBy','modulo','semDuploComando','rowColor','examModalityA','examModalityB',
];

/** Campos removidos de cada tabela de módulo — não podem ser gravados nelas */
const MODULE_DROPPED_FIELDS: Record<string, string[]> = {
  CNH_BRASIL: ['schoolId', 'paidFee', 'disabilityType', 'specialNeeds', 'categoryQuantities', 'interestedExaminers'],
  CFC: [
    'studentName', 'socialName', 'cpf', 'phone', 'email', 'address', 'city',
    'paidFee', 'taxaPaga', 'completedPracticalCourse', 'practicalHours', 'hasVehicle',
    'cnhRestriction', 'instructor', 'vehiclePlate', 'semDuploComando', 'checklistVehicle',
    'practicalCourseInserted', 'disabilityType', 'specialNeeds', 'examModalityA', 'examModalityB', 'examHistory',
  ],
  PCD: ['paidFee', 'semDuploComando', 'categoryQuantities', 'examModalityA', 'examModalityB', 'interestedExaminers'],
};

/** Remove campos que não existem mais na tabela do módulo alvo */
function stripDroppedFields(obj: any, modulo: string): any {
  const dropped = MODULE_DROPPED_FIELDS[modulo] ?? [];
  if (dropped.length === 0) return obj;
  const out = { ...obj };
  for (const f of dropped) delete out[f];
  return out;
}

function deriveModulo(data: any): string {
  if (data.examType === 'PCD' || data.schoolId === 'PCD') return 'PCD';
  if (!data.schoolId || data.schoolId === '' || data.schoolId === 'CNH_BRASIL') return 'CNH_BRASIL';
  return 'CFC';
}

function filterFields(obj: any) {
  const out: any = {};
  for (const k of ALLOWED_FIELDS) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function getRequestTable(modulo: string) {
  if (modulo === 'PCD') return pcdRequests;
  if (modulo === 'CFC') return cfcRequests;
  return cnhbrasilRequests;
}

/** Encontra um request pelo ID em qualquer das 3 tabelas — retorna camelCase via ORM com PII descriptografado */
async function findRequestById(db: any, id: string, env?: any): Promise<{ row: any; modulo: string } | null> {
  const [cnhRows, cfcRows, pcdRows] = await Promise.all([
    db.select().from(cnhbrasilRequests).where(eq(cnhbrasilRequests.id, id)).limit(1),
    db.select().from(cfcRequests).where(eq(cfcRequests.id, id)).limit(1),
    db.select().from(pcdRequests).where(eq(pcdRequests.id, id)).limit(1),
  ]);
  if (cnhRows.length > 0) return { row: await decryptRequestPii(cnhRows[0], env), modulo: 'CNH_BRASIL' };
  if (cfcRows.length > 0) return { row: cfcRows[0], modulo: 'CFC' };
  if (pcdRows.length > 0) return { row: await decryptRequestPii(pcdRows[0], env), modulo: 'PCD' };
  return null;
}

export const onRequest: PagesFunction<{ DATABASE_URL: string }> = async ({ request, env, data }) => {
  try {
    const db = getDb(env as any);
    const method = request.method;
    const query = getQuery(request.url);

    if (method === 'GET') {
      if (query.cpf) {
        const clean = query.cpf.replace(/\D/g, '');
        const pattern = `%${clean}%`;
        const hmac = clean.length === 11 ? await computeCpfHmac(clean, env as any) : null;
        if (hmac) {
          const [cnhRows, pcdRows] = await Promise.all([
            db.select().from(cnhbrasilRequests).where(or(eq(cnhbrasilRequests.cpfHmac, hmac), like(cnhbrasilRequests.cpf, pattern))),
            db.select().from(pcdRequests).where(or(eq(pcdRequests.cpfHmac, hmac), like(pcdRequests.cpf, pattern))),
          ]);
          const decrypted = await Promise.all([...cnhRows, ...pcdRows].map(r => decryptRequestPii(r, env as any)));
          return json(decrypted);
        }
        const [cnhRows, pcdRows] = await Promise.all([
          db.select().from(cnhbrasilRequests),
          db.select().from(pcdRequests),
        ]);
        const decrypted = await Promise.all([...cnhRows, ...pcdRows].map(r => decryptRequestPii(r, env as any)));
        return json(decrypted.filter(r => String(r?.cpf ?? '').replace(/\D/g, '').includes(clean)));
      }
      const [cnhRows, cfcRows, pcdRows] = await Promise.all([
        db.select().from(cnhbrasilRequests),
        db.select().from(cfcRequests),
        db.select().from(pcdRequests),
      ]);
      const [decCnh, decPcd] = await Promise.all([
        Promise.all(cnhRows.map((r: any) => decryptRequestPii(r, env as any))),
        Promise.all(pcdRows.map((r: any) => decryptRequestPii(r, env as any))),
      ]);
      return json([...decCnh, ...cfcRows, ...decPcd]);
    }

    if (method === 'POST') {
      const body = await parseBody<any>(request);
      const modalityError = modalityValidationError(body);
      if (modalityError) return error(modalityError, 400);
      const filtered = filterFields(body);
      if (!filtered.modulo) filtered.modulo = deriveModulo(filtered);
      if (filtered.paidFee !== undefined && filtered.taxaPaga === undefined) filtered.taxaPaga = filtered.paidFee;
      if (filtered.modulo !== 'CFC') {
        filtered.studentName = filtered.studentName || null;
        filtered.phone = filtered.phone || null;
      }
      const stripped = stripDroppedFields(filtered, filtered.modulo);
      const valuesToSave = stripped.modulo === 'CFC'
        ? stripped
        : await encryptRequestPii(stripped, env as any);
      const table = getRequestTable(valuesToSave.modulo);
      const newItem = await db.insert(table).values({
        id: valuesToSave.id || crypto.randomUUID(),
        ...valuesToSave,
        createdAt: filtered.createdAt ? new Date(filtered.createdAt) : new Date(),
        updatedAt: new Date(),
      }).returning();
      const record = await decryptRequestPii(newItem[0] as any, env as any);
      if (record?.modulo === 'CNH_BRASIL') {
        await writeAuditLog(db, extractActor(request, data), 'Foi cadastrado', 'CNH_BRASIL_CANDIDATO', record.id, {
          cpf: maskCpf(record.cpf),
          name: record.studentName ?? null,
        });
      }
      return json(record ?? { id: body.id, ...body });
    }

    if (method === 'PUT') {
      const body = await parseBody<any>(request);
      const modalityError = modalityValidationError(body);
      if (modalityError) return error(modalityError, 400);
      if (!body?.id) return error('ID obrigatório', 400);
      const { id, updatedAt, createdAt, ...rawUpdates } = body;
      const filtered = filterFields(rawUpdates);
      if (filtered.paidFee !== undefined && filtered.taxaPaga === undefined) filtered.taxaPaga = filtered.paidFee;
      if (filtered.queueUpdatedAt && typeof filtered.queueUpdatedAt === 'string') {
        filtered.queueUpdatedAt = new Date(filtered.queueUpdatedAt);
      }

      // Encontra registro atual (camelCase via ORM)
      const found = await findRequestById(db, id, env as any);
      const role = (data as any)?.sessionUserRole;
      if (body.registerInterest || body.removeInterest) {
        if (!UpdateExamRequestBody.safeParse(body).success || (body.registerInterest && body.removeInterest)) {
          return error('Operação de interesse inválida.', 400);
        }
        // "Tenho interesse": identidade vem da sessão, nunca do corpo da requisição.
        const sessionUserId = (data as any)?.sessionUserId;
        const [sessionUser] = sessionUserId
          ? await db.select({ examinerId: users.examinerId }).from(users).where(eq(users.id, sessionUserId)).limit(1)
          : [];
        const [examiner] = sessionUser?.examinerId
          ? await db.select({ id: examiners.id, name: examiners.name }).from(examiners).where(eq(examiners.id, sessionUser.examinerId)).limit(1)
          : [];
        const invalid = interestError(found?.row, found?.modulo ?? '', role, examiner, body.removeInterest === true);
        if (invalid) return error(invalid.error, invalid.status);
        const rows = await db.update(cfcRequests).set({ ...interestPatch(found!.row, examiner!, new Date(), body.removeInterest === true), updatedAt: new Date() })
          .where(and(eq(cfcRequests.id, id), eq(cfcRequests.status, 'WAITING_SCHEDULING'))).returning();
        if (!rows.length) return error('O pedido mudou. Atualize a lista.', 409);
        return json(rows[0]);
      }
      if (body.extraEdit) {
        const invalid = extraEditError(found?.row, found?.modulo ?? '', role, body);
        if (invalid) return error(invalid.error, invalid.status);
        const rows = await db.update(cfcRequests).set({ ...extraPatch(body), updatedAt: new Date() })
          .where(and(eq(cfcRequests.id, id), eq(cfcRequests.status, 'WAITING_SCHEDULING'))).returning();
        if (!rows.length) return error('O pedido mudou. Atualize a lista.', 409);
        return json(rows[0]);
      }
      const denied = confirmedAccessError(found?.row, found?.modulo ?? '', false, role, body);
      if (denied) return error(denied, body.confirmedEdit && !isConfirmedCfc(found?.row, found?.modulo ?? '') ? 409 : 403);
      if (body.confirmedEdit) {
        if (!canManageConfirmed(role)) return error('Acesso negado.', 403);
        const invalid = await validateConfirmedEdit(db, { examiners, systemSettings, blockedDates }, found!.row, body);
        if (invalid) return error(invalid, 400);
        const rows = await db.update(cfcRequests).set({ ...confirmedPatch(body), updatedAt: new Date() })
          .where(and(eq(cfcRequests.id, id), eq(cfcRequests.status, 'SCHEDULED'), eq(cfcRequests.attendanceConfirmed, true))).returning();
        if (!rows.length) return error('O agendamento mudou. Atualize a lista.', 409);
        return json(rows[0]);
      }
      const isResultConfirmation =
        rawUpdates.result !== undefined &&
        Array.isArray(rawUpdates.examHistory);
      const isCurrentlyScheduled = found?.row?.status === 'SCHEDULED';
      // Supervisor pode remover candidatos da banca no módulo CNH Brasil
      const isCnhBrasil = (found?.modulo ?? deriveModulo(rawUpdates)) === 'CNH_BRASIL';
      if (
        (data as any)?.sessionUserRole === 'SUPERVISOR' &&
        !isCnhBrasil &&
        (
          rawUpdates.scheduleId === null ||
          (
            isCurrentlyScheduled &&
            rawUpdates.scheduleId !== undefined &&
            rawUpdates.scheduleId !== found?.row?.scheduleId
          ) ||
          (
            isCurrentlyScheduled &&
            rawUpdates.status === 'WAITING_SCHEDULING' &&
            !isResultConfirmation
          )
        )
      ) {
        return error('Supervisores não podem remover candidatos da banca.', 403);
      }
      const oldModulo = found?.modulo ?? deriveModulo(rawUpdates);
      // Deriva módulo destino a partir dos dados mesclados (old + incoming)
      // para capturar mudanças em examType/schoolId mesmo sem campo modulo explícito
      const mergedExamType = rawUpdates.examType ?? found?.row?.examType;
      const mergedSchoolId = rawUpdates.schoolId ?? found?.row?.schoolId;
      const newModulo = filtered.modulo || deriveModulo({ examType: mergedExamType, schoolId: mergedSchoolId });
      if (
        (data as any)?.sessionUserRole === 'SUPERVISOR' &&
        isCurrentlyScheduled &&
        newModulo !== found?.modulo
      ) {
        return error('Supervisores não podem mover candidatos agendados para outro módulo.', 403);
      }
      const oldTable = getRequestTable(oldModulo);
      const newTable = getRequestTable(newModulo);

      let record: any;
      if (oldModulo !== newModulo) {
        // Módulo mudou: mover linha atomicamente para a tabela destino
        // Merge camelCase (ORM) + incoming updates + modulo correto
        const mergedPlain = stripDroppedFields(
          { ...found?.row, ...filtered, modulo: newModulo, updatedAt: new Date() },
          newModulo
        );
        const mergedToSave = newModulo === 'CFC'
          ? mergedPlain
          : await encryptRequestPii(mergedPlain, env as any);
        await db.batch([
          db.insert(newTable).values(mergedToSave),
          db.delete(oldTable).where(eq(oldTable.id, id)),
        ]);
        record = await decryptRequestPii(mergedPlain, env as any);
      } else {
        const stripped = stripDroppedFields({ ...filtered, updatedAt: new Date() }, newModulo);
        const toUpdate = newModulo === 'CFC'
          ? stripped
          : await encryptRequestPii(stripped, env as any);
        const updated = await db.update(oldTable)
          .set(toUpdate)
          .where(eq(oldTable.id, id))
          .returning();
        record = await decryptRequestPii(updated[0], env as any);
      }

      if ((record?.modulo ?? newModulo) === 'CNH_BRASIL') {
        let action = 'Foi modificado';
        if (body.scheduleId && body.status === 'SCHEDULED') action = 'Foi adicionado na Banca';
        else if (body.scheduleId === null && body.status === 'WAITING_SCHEDULING') action = 'Foi excluído da Banca';
        await writeAuditLog(db, extractActor(request, data), action, 'CNH_BRASIL_CANDIDATO', id, {
          cpf: maskCpf((record ?? found?.row)?.cpf),
          name: (record ?? found?.row)?.studentName ?? null,
        });
      }
      return json(record ?? { id, ...rawUpdates });
    }

    if (method === 'DELETE') {
      const id = query.id;
      if (!id) return error('ID obrigatório', 400);
      const found = await findRequestById(db, id, env as any);
      const role = (data as any)?.sessionUserRole;
      if (isConfirmedCfc(found?.row, found?.modulo ?? '') && !canManageConfirmed(role)) {
        return error('Somente administradores e supervisores podem excluir provas confirmadas.', 403);
      }
      if (query.confirmedDelete === 'true') {
        if (!canManageConfirmed(role)) return error('Acesso negado.', 403);
        if (!isConfirmedCfc(found?.row, found?.modulo ?? '')) return error('O agendamento não está mais confirmado.', 409);
        const condition = and(eq(cfcRequests.id, id), eq(cfcRequests.status, 'SCHEDULED'), eq(cfcRequests.attendanceConfirmed, true));
        const affected = hasCandidateIdentity(found!.row)
          ? await db.update(cfcRequests).set({ ...clearAppointment, updatedAt: new Date() }).where(condition).returning()
          : await db.delete(cfcRequests).where(condition).returning();
        if (!affected.length) return error('O agendamento mudou. Atualize a lista.', 409);
        return json({ success: true });
      }
      if ((data as any)?.sessionUserRole === 'SUPERVISOR') {
        return error('Supervisores não podem excluir candidatos.', 403);
      }
      // Busca antes de excluir para poder registrar no log
      // Apaga das 3 tabelas (apenas uma terá o registro)
      await db.delete(cnhbrasilRequests).where(eq(cnhbrasilRequests.id, id));
      await db.delete(cfcRequests).where(eq(cfcRequests.id, id));
      await db.delete(pcdRequests).where(eq(pcdRequests.id, id));
      if (found?.modulo === 'CNH_BRASIL') {
        await writeAuditLog(db, extractActor(request, data), 'Foi excluído', 'CNH_BRASIL_CANDIDATO', id, {
          cpf: maskCpf(found.row?.cpf),
          name: found.row?.studentName ?? null,
        });
      }
      return json({ success: true });
    }

    return error('Method Not Allowed', 405);
  } catch (e: any) {
    console.error('[requests] erro:', e);
    return error(e.message ?? 'Erro interno', 500);
  }
};
