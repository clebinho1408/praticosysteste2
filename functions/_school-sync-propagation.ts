import { eq } from 'drizzle-orm';
import {
  businessDate,
  isCalendarDate,
  isValidScaleTime,
  normalizeScaleTime,
  resolveSchoolScaleForDate,
} from './_school-schedule.js';
import { isSystemDateBlockedForRotation } from './_school-rotation.js';
import {
  calculateScheduleStatus,
  isSchoolEligibleForCnhAutoBancas,
  type AutoCnhBancaLink,
} from './_cnh-auto-bancas.js';
import { cnhBancaConflict } from './_cnh-time-conflicts.js';

const dateOnly = (value?: string | null) => String(value ?? '').split('T')[0].trim();

export interface SchoolSyncTables {
  drivingSchools: any;
  examiners: any;
  examSchedules: any;
  cfcScheduleSlots: any;
  cfcRequests: any;
  cnhbrasilRequests: any;
  blockedDates: any;
  systemSettings: any;
}

interface ScaleSlotPair {
  time: string;
  examinerId: string;
}

function buildExaminerResolver(examinerList: any[]) {
  const byId = new Map<string, any>();
  const byNameUpper = new Map<string, any>();
  for (const ex of examinerList ?? []) {
    if (!ex?.id) continue;
    byId.set(String(ex.id), ex);
    const nameUpper = String(ex.name ?? '').trim().toUpperCase();
    if (nameUpper && !byNameUpper.has(nameUpper)) {
      byNameUpper.set(nameUpper, ex);
    }
  }
  const resolveExaminer = (idOrName?: string | null): any | null => {
    const raw = String(idOrName ?? '').trim();
    if (!raw) return null;
    if (byId.has(raw)) return byId.get(raw)!;
    return byNameUpper.get(raw.toUpperCase()) ?? null;
  };
  const resolveExaminerId = (idOrName?: string | null): string => {
    const raw = String(idOrName ?? '').trim();
    if (!raw) return '';
    return resolveExaminer(raw)?.id ?? raw;
  };
  return { resolveExaminer, resolveExaminerId };
}

function resolveExpectedPairsForDate(
  school: any,
  date: string,
  resolveExaminerId: (idOrName?: string | null) => string,
): { kind: 'PAUSED' | 'INACTIVE' | 'WEEKLY_SLOTS' | 'PROVISIONAL_DATES' | 'ROTATION_DATES'; pairs: ScaleSlotPair[] } {
  const resolved = resolveSchoolScaleForDate(
    {
      examRotation: Boolean(school?.examRotation),
      mainSchedule: school?.mainSchedule ?? null,
      provisionalSchedule: school?.provisionalSchedule ?? null,
    },
    date,
  );
  if (resolved.kind === 'PAUSED' || resolved.kind === 'INACTIVE') {
    return { kind: resolved.kind, pairs: [] };
  }
  if (resolved.kind === 'PROVISIONAL_DATES') {
    return {
      kind: 'PROVISIONAL_DATES',
      pairs: resolved.specificDates
        .filter(s => isValidScaleTime(s.time) && String(s.examiner ?? '').trim() !== '')
        .map(s => ({
          time: normalizeScaleTime(s.time),
          examinerId: resolveExaminerId(s.examiner),
        })),
    };
  }
  if (resolved.kind === 'ROTATION_DATES') {
    const suppressed = Array.isArray(school?.mainSchedule?.suppressedRotationDates)
      ? school.mainSchedule.suppressedRotationDates
      : [];
    if (suppressed.includes(date)) {
      return { kind: 'ROTATION_DATES', pairs: [] };
    }
    return {
      kind: 'ROTATION_DATES',
      pairs: resolved.entries
        .filter(s => isValidScaleTime(s.time) && String(s.examiner ?? '').trim() !== '')
        .map(s => ({
          time: normalizeScaleTime(s.time),
          examinerId: resolveExaminerId(s.examiner),
        })),
    };
  }
  return {
    kind: 'WEEKLY_SLOTS',
    pairs: resolved.slots
      .filter(s => isValidScaleTime(s.time) && String(s.examiner ?? '').trim() !== '')
      .map(s => ({
        time: normalizeScaleTime(s.time),
        examinerId: resolveExaminerId(s.examiner),
      })),
  };
}

function canonicalPairsKey(pairs: ScaleSlotPair[]): string {
  return [...pairs]
    .map(p => `${normalizeScaleTime(p.time)}|${p.examinerId}`)
    .sort()
    .join(';');
}

function canonicalTimesKey(pairs: ScaleSlotPair[]): string {
  return [...pairs]
    .map(p => normalizeScaleTime(p.time))
    .sort()
    .join(';');
}

function resolveRequestReassignment(
  prevPairs: ScaleSlotPair[],
  nextPairs: ScaleSlotPair[],
  reqExaminerId: string,
  reqTime: string,
): { examinerId: string; scheduledTime?: string } | null {
  if (nextPairs.length === 0) return null;
  const normReqTime = normalizeScaleTime(reqTime);

  // Caso 1: Mesmo horário — havia 1 examinador antes e 1 depois neste horário
  const prevAtTime = prevPairs.filter(p => p.time === normReqTime);
  const nextAtTime = nextPairs.filter(p => p.time === normReqTime);
  if (
    prevAtTime.length === 1 &&
    nextAtTime.length === 1 &&
    prevAtTime[0].examinerId === reqExaminerId &&
    nextAtTime[0].examinerId !== reqExaminerId
  ) {
    return { examinerId: nextAtTime[0].examinerId };
  }

  // Caso 2: A escola tem exatamente 1 prova nesta data (antes e depois)
  if (
    prevPairs.length === 1 &&
    nextPairs.length === 1 &&
    prevPairs[0].examinerId === reqExaminerId
  ) {
    const examinerChanged = nextPairs[0].examinerId !== reqExaminerId;
    const timeChanged = nextPairs[0].time !== normReqTime;
    if (examinerChanged || timeChanged) {
      return {
        examinerId: nextPairs[0].examinerId,
        ...(timeChanged ? { scheduledTime: nextPairs[0].time } : {}),
      };
    }
  }

  return null;
}

export async function syncDerivedSchedulesOnSchoolUpdate(
  db: any,
  tables: SchoolSyncTables,
  options: {
    currentSchool: any;
    updatedSchool: any;
    today?: string;
    now?: Date;
  },
): Promise<{
  deletedSlotIds: string[];
  createdSlotIds: string[];
  updatedRequestIds: string[];
  updatedBancaIds: string[];
  deletedBancaIds: string[];
}> {
  const now = options.now ?? new Date();
  const today = options.today && isCalendarDate(options.today) ? options.today : businessDate(now);
  const currentSchool = options.currentSchool;
  const updatedSchool = options.updatedSchool;

  const deletedSlotIds: string[] = [];
  const createdSlotIds: string[] = [];
  const updatedRequestIds: string[] = [];
  const updatedBancaIds: string[] = [];
  const deletedBancaIds: string[] = [];

  if (!updatedSchool?.id) {
    return { deletedSlotIds, createdSlotIds, updatedRequestIds, updatedBancaIds, deletedBancaIds };
  }

  const [examinerRows, schoolSlotsRaw, schoolRequestsRaw] = await Promise.all([
    db.select().from(tables.examiners),
    db.select().from(tables.cfcScheduleSlots).where(eq(tables.cfcScheduleSlots.schoolId, updatedSchool.id)),
    db.select().from(tables.cfcRequests).where(eq(tables.cfcRequests.schoolId, updatedSchool.id)),
  ]);

  const { resolveExaminer, resolveExaminerId } = buildExaminerResolver(examinerRows);

  // ── 1. Sincronizar slots FIXA futuros em vagas_cfc e solicitacoes_cfc ────────
  const futureFixedSlots = (schoolSlotsRaw as any[]).filter(slot => {
    const d = dateOnly(slot?.scheduledDate);
    return (
      slot &&
      isCalendarDate(d) &&
      d >= today &&
      slot.requestType === 'FIXA' &&
      slot.status === 'SCHEDULED'
    );
  });

  const futureFixedRequests = (schoolRequestsRaw as any[]).filter(req => {
    const d = dateOnly(req?.scheduledDate);
    return (
      req &&
      isCalendarDate(d) &&
      d >= today &&
      req.requestType === 'FIXA' &&
      req.status === 'SCHEDULED'
    );
  });

  const datesToCheck = new Set<string>([
    ...futureFixedSlots.map(s => dateOnly(s.scheduledDate)),
    ...futureFixedRequests.map(r => dateOnly(r.scheduledDate)),
  ]);

  const slotsByDate = new Map<string, any[]>();
  for (const slot of futureFixedSlots) {
    const d = dateOnly(slot.scheduledDate);
    const list = slotsByDate.get(d) ?? [];
    list.push(slot);
    slotsByDate.set(d, list);
  }

  const reqsByDate = new Map<string, any[]>();
  for (const req of futureFixedRequests) {
    const d = dateOnly(req.scheduledDate);
    const list = reqsByDate.get(d) ?? [];
    list.push(req);
    reqsByDate.set(d, list);
  }

  const stamp = Date.now();
  for (const date of [...datesToCheck].sort()) {
    const dateSlots = slotsByDate.get(date) ?? [];
    const dateReqs = reqsByDate.get(date) ?? [];
    const prevSpec = resolveExpectedPairsForDate(currentSchool, date, resolveExaminerId);
    const nextSpec = resolveExpectedPairsForDate(updatedSchool, date, resolveExaminerId);

    // Atualiza solicitações de alunos (solicitacoes_cfc) quando houve troca inequívoca de examinador/horário
    if (dateReqs.length > 0 && canonicalPairsKey(prevSpec.pairs) !== canonicalPairsKey(nextSpec.pairs)) {
      for (const req of dateReqs) {
        const reqExaminerId = resolveExaminerId(req.examinerId);
        const reassignment = resolveRequestReassignment(
          prevSpec.pairs,
          nextSpec.pairs,
          reqExaminerId,
          String(req.scheduledTime ?? ''),
        );
        if (!reassignment) continue;
        await db
          .update(tables.cfcRequests)
          .set({
            examinerId: reassignment.examinerId,
            ...(reassignment.scheduledTime ? { scheduledTime: reassignment.scheduledTime } : {}),
            updatedAt: now,
          })
          .where(eq(tables.cfcRequests.id, req.id));
        updatedRequestIds.push(req.id);
      }
    }

    if (dateSlots.length === 0) continue;

    const existingPairs: ScaleSlotPair[] = dateSlots.map(s => ({
      time: normalizeScaleTime(s.scheduledTime),
      examinerId: resolveExaminerId(s.examinerId),
    }));

    const legacyWeeklyRotationUnchanged =
      Boolean(updatedSchool.examRotation) &&
      nextSpec.kind === 'WEEKLY_SLOTS' &&
      Boolean(currentSchool?.examRotation) &&
      prevSpec.kind === 'WEEKLY_SLOTS' &&
      canonicalTimesKey(prevSpec.pairs) === canonicalTimesKey(nextSpec.pairs) &&
      canonicalTimesKey(existingPairs) === canonicalTimesKey(nextSpec.pairs);

    if (legacyWeeklyRotationUnchanged) {
      continue;
    }

    const needsSlotSync =
      nextSpec.pairs.length === 0 ||
      canonicalPairsKey(existingPairs) !== canonicalPairsKey(nextSpec.pairs) ||
      canonicalPairsKey(prevSpec.pairs) !== canonicalPairsKey(nextSpec.pairs);

    if (!needsSlotSync) continue;

    // Remove os slots antigos daquela data primeiro (evita conflito de trigger no D1 e remove o examinador antigo imediatamente)
    for (const oldSlot of dateSlots) {
      await db.delete(tables.cfcScheduleSlots).where(eq(tables.cfcScheduleSlots.id, oldSlot.id));
      deletedSlotIds.push(oldSlot.id);
    }

    if (nextSpec.pairs.length > 0) {
      const sameDateAllSlots = (await db
        .select()
        .from(tables.cfcScheduleSlots)
        .where(eq(tables.cfcScheduleSlots.scheduledDate, date))) as any[];
      const activeSameDate = sameDateAllSlots.filter(s => s && s.status !== 'CANCELLED');

      const template = dateSlots[0];
      for (let idx = 0; idx < nextSpec.pairs.length; idx++) {
        const pair = nextSpec.pairs[idx];
        const hasTimeConflict = activeSameDate.some(
          b =>
            resolveExaminerId(b.examinerId) === pair.examinerId &&
            normalizeScaleTime(b.scheduledTime) === pair.time,
        );
        if (hasTimeConflict) continue;

        const newId = `auto-fixed:${updatedSchool.id}:${date}:${stamp}:${idx}`;
        const newSlot = {
          id: newId,
          schoolId: updatedSchool.id,
          examType: template?.examType ?? 'COMMON',
          requestType: 'FIXA',
          intendedCategory: template?.intendedCategory ?? 'A,B',
          scheduledDate: date,
          scheduledTime: pair.time,
          examinerId: pair.examinerId,
          scheduleId: template?.scheduleId ?? null,
          scheduledCategory: template?.scheduledCategory ?? null,
          status: 'SCHEDULED',
          attendanceConfirmed: template?.attendanceConfirmed ?? true,
          cancellationReason: null,
          observation: template?.observation ?? '',
          createdAt: now,
          updatedAt: now,
        };
        try {
          await db.insert(tables.cfcScheduleSlots).values(newSlot);
          activeSameDate.push(newSlot);
          createdSlotIds.push(newId);
        } catch {
          // Não aborta o salvamento da autoescola se um examinador estiver no limite diário/conflito no D1
        }
      }
    }
  }

  // ── 2. Sincronizar bancas CNH auto-criadas vinculadas a esta autoescola ─────
  const rawPrevLinks: AutoCnhBancaLink[] = Array.isArray(currentSchool?.mainSchedule?.autoCnhBancaLinks)
    ? currentSchool.mainSchedule.autoCnhBancaLinks
    : [];
  const rawNextLinks: AutoCnhBancaLink[] = Array.isArray(updatedSchool?.mainSchedule?.autoCnhBancaLinks)
    ? updatedSchool.mainSchedule.autoCnhBancaLinks
    : [];
  const combinedLinks: AutoCnhBancaLink[] = [];
  const seenLinkScheduleIds = new Set<string>();
  for (const link of [...rawNextLinks, ...rawPrevLinks]) {
    if (!link?.scheduleId || seenLinkScheduleIds.has(link.scheduleId)) continue;
    seenLinkScheduleIds.add(link.scheduleId);
    combinedLinks.push(link);
  }

  if (combinedLinks.length > 0) {
    const [allBancasRaw, cnhReqRows, blockedRows, settingsRows] = await Promise.all([
      db.select().from(tables.examSchedules),
      db.select().from(tables.cnhbrasilRequests),
      db.select().from(tables.blockedDates),
      db.select().from(tables.systemSettings),
    ]);

    const allBancas = [...(allBancasRaw as any[])];
    const activeCnhCountBySchedule = new Map<string, number>();
    for (const r of cnhReqRows as any[]) {
      if (!r?.scheduleId || r.status === 'CANCELLED') continue;
      activeCnhCountBySchedule.set(r.scheduleId, (activeCnhCountBySchedule.get(r.scheduleId) ?? 0) + 1);
    }

    const settingsRow = (settingsRows as any[])[0] ?? null;
    const schoolEligible = isSchoolEligibleForCnhAutoBancas(updatedSchool);
    const pausedSet = new Set(
      (Array.isArray(updatedSchool?.mainSchedule?.pausedDates) ? updatedSchool.mainSchedule.pausedDates : []).filter(
        isCalendarDate,
      ),
    );
    const suppressedSet = new Set(
      (Array.isArray(updatedSchool?.mainSchedule?.suppressedRotationDates)
        ? updatedSchool.mainSchedule.suppressedRotationDates
        : []
      ).filter(isCalendarDate),
    );
    const rotationEntries: any[] = Array.isArray(updatedSchool?.mainSchedule?.rotationEntries)
      ? updatedSchool.mainSchedule.rotationEntries
      : [];

    const nextLinks: AutoCnhBancaLink[] = [];
    let linksChanged = false;

    for (const link of combinedLinks) {
      const bancaIdx = allBancas.findIndex(b => b?.id === link.scheduleId);
      if (bancaIdx === -1) {
        linksChanged = true;
        continue;
      }
      const banca = allBancas[bancaIdx];
      const bancaDate = dateOnly(banca.date);
      const bancaTime = normalizeScaleTime(banca.time);
      const effectiveStatus = calculateScheduleStatus(bancaDate, bancaTime, banca.status, now);

      if (!isCalendarDate(bancaDate) || bancaDate < today || banca.status !== 'OPEN' || effectiveStatus !== 'OPEN') {
        nextLinks.push(link);
        continue;
      }

      const activeRequests = activeCnhCountBySchedule.get(banca.id) ?? 0;
      const dateIsActive =
        schoolEligible &&
        !pausedSet.has(bancaDate) &&
        !suppressedSet.has(bancaDate) &&
        !isSystemDateBlockedForRotation(bancaDate, blockedRows, settingsRow).blocked;

      const matchedEntry = dateIsActive
        ? rotationEntries.find(e => e && dateOnly(e.date) === bancaDate && link.entryId && e.id === link.entryId) ??
          rotationEntries.find(e => e && dateOnly(e.date) === bancaDate)
        : undefined;

      const resolvedEx = matchedEntry ? resolveExaminer(matchedEntry.examiner) : null;
      const entryTime = matchedEntry ? normalizeScaleTime(matchedEntry.time) : '';
      const entryValid = Boolean(matchedEntry && resolvedEx && isValidScaleTime(entryTime));

      if (!entryValid) {
        if (activeRequests === 0) {
          await db.delete(tables.examSchedules).where(eq(tables.examSchedules.id, banca.id));
          allBancas.splice(bancaIdx, 1);
          deletedBancaIds.push(banca.id);
          linksChanged = true;
        } else {
          nextLinks.push(link);
        }
        continue;
      }

      const currentExaminerIds = Array.isArray(banca.examinerIds) ? banca.examinerIds : [];
      const sameExaminer = currentExaminerIds.length === 1 && currentExaminerIds[0] === resolvedEx.id;
      const sameTime = bancaTime === entryTime;

      if (sameExaminer && sameTime) {
        nextLinks.push({
          scheduleId: banca.id,
          date: bancaDate,
          time: bancaTime,
          ...(matchedEntry.id ? { entryId: matchedEntry.id } : {}),
        });
        if (link.entryId !== matchedEntry.id || link.time !== bancaTime || link.date !== bancaDate) {
          linksChanged = true;
        }
        continue;
      }

      if (activeRequests === 0) {
        const conflict =
          !sameTime &&
          cnhBancaConflict(
            { type: 'COMMON', status: 'OPEN', date: bancaDate, time: entryTime },
            allBancas.filter(b => b.id !== banca.id),
          );
        if (conflict) {
          await db.delete(tables.examSchedules).where(eq(tables.examSchedules.id, banca.id));
          allBancas.splice(bancaIdx, 1);
          deletedBancaIds.push(banca.id);
          linksChanged = true;
          continue;
        }
        const maxSlotsA = resolvedEx.defaultMaxSlotsA ?? settingsRow?.defaultMaxSlotsA ?? banca.maxSlotsA ?? 10;
        const maxSlotsB = resolvedEx.defaultMaxSlotsB ?? settingsRow?.defaultMaxSlotsB ?? banca.maxSlotsB ?? 10;
        await db
          .update(tables.examSchedules)
          .set({
            examinerIds: [resolvedEx.id],
            time: entryTime,
            maxSlotsA,
            maxSlotsB,
          })
          .where(eq(tables.examSchedules.id, banca.id));
        allBancas[bancaIdx] = {
          ...banca,
          examinerIds: [resolvedEx.id],
          time: entryTime,
          maxSlotsA,
          maxSlotsB,
        };
        updatedBancaIds.push(banca.id);
        nextLinks.push({
          scheduleId: banca.id,
          date: bancaDate,
          time: entryTime,
          ...(matchedEntry.id ? { entryId: matchedEntry.id } : {}),
        });
        linksChanged = true;
      } else if (sameTime) {
        await db
          .update(tables.examSchedules)
          .set({ examinerIds: [resolvedEx.id] })
          .where(eq(tables.examSchedules.id, banca.id));
        allBancas[bancaIdx] = { ...banca, examinerIds: [resolvedEx.id] };
        updatedBancaIds.push(banca.id);
        nextLinks.push({
          scheduleId: banca.id,
          date: bancaDate,
          time: bancaTime,
          ...(matchedEntry.id ? { entryId: matchedEntry.id } : {}),
        });
        if (link.entryId !== matchedEntry.id) linksChanged = true;
      } else {
        nextLinks.push(link);
      }
    }

    if (linksChanged && updatedSchool.mainSchedule && typeof updatedSchool.mainSchedule === 'object') {
      const updatedMainSchedule = {
        ...updatedSchool.mainSchedule,
        autoCnhBancaLinks: nextLinks,
      };
      await db
        .update(tables.drivingSchools)
        .set({ mainSchedule: updatedMainSchedule })
        .where(eq(tables.drivingSchools.id, updatedSchool.id));
      updatedSchool.mainSchedule = updatedMainSchedule;
    }
  }

  return {
    deletedSlotIds,
    createdSlotIds,
    updatedRequestIds,
    updatedBancaIds,
    deletedBancaIds,
  };
}

export async function cleanupDerivedSchedulesOnSchoolDelete(
  db: any,
  tables: Pick<SchoolSyncTables, 'cfcScheduleSlots' | 'examSchedules' | 'cnhbrasilRequests'>,
  options: {
    school: any;
    today?: string;
    now?: Date;
  },
): Promise<{ deletedSlotIds: string[]; deletedBancaIds: string[] }> {
  const now = options.now ?? new Date();
  const today = options.today && isCalendarDate(options.today) ? options.today : businessDate(now);
  const school = options.school;
  const deletedSlotIds: string[] = [];
  const deletedBancaIds: string[] = [];

  if (!school?.id) return { deletedSlotIds, deletedBancaIds };

  const schoolSlots = (await db
    .select()
    .from(tables.cfcScheduleSlots)
    .where(eq(tables.cfcScheduleSlots.schoolId, school.id))) as any[];

  for (const slot of schoolSlots) {
    const d = dateOnly(slot?.scheduledDate);
    if (slot && isCalendarDate(d) && d >= today && slot.requestType === 'FIXA' && slot.status === 'SCHEDULED') {
      await db.delete(tables.cfcScheduleSlots).where(eq(tables.cfcScheduleSlots.id, slot.id));
      deletedSlotIds.push(slot.id);
    }
  }

  const links: AutoCnhBancaLink[] = Array.isArray(school?.mainSchedule?.autoCnhBancaLinks)
    ? school.mainSchedule.autoCnhBancaLinks
    : [];
  if (links.length > 0) {
    const [allBancas, cnhReqs] = await Promise.all([
      db.select().from(tables.examSchedules),
      db.select().from(tables.cnhbrasilRequests),
    ]);
    const activeCounts = new Map<string, number>();
    for (const r of cnhReqs as any[]) {
      if (!r?.scheduleId || r.status === 'CANCELLED') continue;
      activeCounts.set(r.scheduleId, (activeCounts.get(r.scheduleId) ?? 0) + 1);
    }
    for (const link of links) {
      if (!link?.scheduleId) continue;
      const banca = (allBancas as any[]).find(b => b?.id === link.scheduleId);
      if (!banca) continue;
      const d = dateOnly(banca.date);
      const t = normalizeScaleTime(banca.time);
      if (isCalendarDate(d) && d >= today && banca.status === 'OPEN' && calculateScheduleStatus(d, t, banca.status, now) === 'OPEN') {
        if ((activeCounts.get(banca.id) ?? 0) === 0) {
          await db.delete(tables.examSchedules).where(eq(tables.examSchedules.id, banca.id));
          deletedBancaIds.push(banca.id);
        }
      }
    }
  }

  return { deletedSlotIds, deletedBancaIds };
}
