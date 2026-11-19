import { eq } from 'drizzle-orm';
import {
  businessDate,
  isCalendarDate,
  isValidScaleTime,
  normalizeScaleTime,
} from './_school-schedule.js';
import {
  isExaminerBlockedOnDateTime,
  isSystemDateBlockedForRotation,
  resolveCityIdByName,
  syncRollingRotationSchedule,
  type RotationBlockedDateLike,
  type RotationCityLike,
  type RotationConfig,
  type RotationExaminerLike,
  type RotationScheduleEntry,
  type RotationSystemSettingsLike,
} from './_school-rotation.js';
import { cnhBancaConflict } from './_cnh-time-conflicts.js';

export interface AutoCnhBancaLink {
  scheduleId: string;
  date: string;
  time: string;
  entryId?: string;
}

export interface AutoBancaSchoolLike {
  id: string;
  name: string;
  city?: string | null;
  cnhBrasilProfile?: boolean | null;
  examRotation?: boolean | null;
  mainSchedule?: {
    active?: boolean;
    days?: string[];
    slots?: any[];
    pausedDates?: string[];
    rotationConfig?: RotationConfig | null;
    rotationEntries?: RotationScheduleEntry[] | null;
    suppressedRotationDates?: string[] | null;
    autoCnhBancaLinks?: AutoCnhBancaLink[] | null;
    [key: string]: any;
  } | null;
  provisionalSchedule?: {
    active?: boolean;
    [key: string]: any;
  } | null;
}

export interface AutoBancaScheduleLike {
  id: string;
  code?: string | null;
  date: string;
  time: string;
  examinerIds?: string[] | null;
  maxSlotsA?: number | null;
  maxSlotsB?: number | null;
  type: string;
  status: string;
  locationId?: string | null;
  cancellationReason?: string | null;
}

export interface AutoBancaExaminerLike extends RotationExaminerLike {
  defaultMaxSlotsA?: number | null;
  defaultMaxSlotsB?: number | null;
}

export interface AutoBancaLocationLike {
  id: string;
  cityId: string;
}

export interface AutoBancaSettingsLike extends RotationSystemSettingsLike {
  defaultMaxSlotsA?: number | null;
  defaultMaxSlotsB?: number | null;
}

export interface NewAutoCnhBanca {
  id: string;
  code: string;
  date: string;
  time: string;
  examinerIds: string[];
  maxSlotsA: number;
  maxSlotsB: number;
  type: 'COMMON';
  status: 'OPEN';
  locationId: string | null;
}

export interface PlanCnhRotationBancasInput {
  schools: AutoBancaSchoolLike[];
  schedules: AutoBancaScheduleLike[];
  examiners: AutoBancaExaminerLike[];
  cities: RotationCityLike[];
  examLocations?: AutoBancaLocationLike[];
  blockedDates?: RotationBlockedDateLike[];
  systemSettings?: AutoBancaSettingsLike | null;
  today?: string;
  now?: Date;
  targetOpenPerSchool?: number;
  createId?: () => string;
}

export interface PlanCnhRotationBancasResult {
  newBancas: NewAutoCnhBanca[];
  schoolUpdates: { schoolId: string; mainSchedule: any }[];
}

const dateOnly = (value?: string | null) => String(value ?? '').split('T')[0];

export function calculateScheduleStatus(
  dateStr: string,
  timeStr: string,
  currentStatus = 'OPEN',
  now = new Date(),
): 'OPEN' | 'CLOSED' | 'CONCLUDED' | 'CANCELLED' {
  if (currentStatus === 'CANCELLED') return 'CANCELLED';
  const cleanDate = dateOnly(dateStr);
  const normTime = normalizeScaleTime(timeStr);
  if (!isCalendarDate(cleanDate) || !isValidScaleTime(normTime)) {
    return (currentStatus as any) || 'OPEN';
  }
  const examDate = new Date(`${cleanDate}T${normTime}`);
  if (Number.isNaN(examDate.getTime())) return (currentStatus as any) || 'OPEN';
  const msPerHr = 60 * 60 * 1000;
  if (now > new Date(examDate.getTime() + 4 * msPerHr)) return 'CONCLUDED';
  if (now > new Date(examDate.getTime() - 12 * msPerHr)) return 'CLOSED';
  return 'OPEN';
}

export function isSchoolEligibleForCnhAutoBancas(school: AutoBancaSchoolLike): boolean {
  if (!school?.cnhBrasilProfile || !school?.examRotation) return false;
  if (school.provisionalSchedule?.active) return false;
  const main = school.mainSchedule;
  if (!main?.active) return false;
  const cfg = main.rotationConfig;
  return Boolean(
    cfg &&
      Array.isArray(cfg.days) &&
      cfg.days.length > 0 &&
      isValidScaleTime(cfg.startTime) &&
      isValidScaleTime(cfg.endTime),
  );
}

function nextCodeSeed(existingSchedules: AutoBancaScheduleLike[]): number {
  let maxCode = 1000;
  for (const s of existingSchedules) {
    if (!s?.code) continue;
    const digits = String(s.code).replace(/\D/g, '');
    if (!digits) continue;
    const parsed = parseInt(digits, 10);
    if (!Number.isNaN(parsed) && parsed > maxCode) {
      maxCode = parsed;
    }
  }
  return maxCode;
}

function serializeLinks(links: AutoCnhBancaLink[]): string {
  return links
    .map(l => `${l.scheduleId}|${l.date}|${l.time}|${l.entryId ?? ''}`)
    .join(';');
}

export function planCnhRotationBancas(input: PlanCnhRotationBancasInput): PlanCnhRotationBancasResult {
  const now = input.now ?? new Date();
  const today = input.today ?? businessDate(now);
  const targetOpenPerSchool = Math.max(1, input.targetOpenPerSchool ?? 2);
  const createId = input.createId ?? (() => crypto.randomUUID());
  const examLocations = input.examLocations ?? [];
  const blockedDates = input.blockedDates ?? [];
  const systemSettings = input.systemSettings ?? null;

  let maxCode = nextCodeSeed(input.schedules);

  const workingCommonBancas: AutoBancaScheduleLike[] = input.schedules
    .filter(s => s?.type === 'COMMON')
    .map(s => ({
      ...s,
      date: dateOnly(s.date),
      time: normalizeScaleTime(s.time),
      status: calculateScheduleStatus(s.date, s.time, s.status, now),
    }));

  const commonById = new Map(workingCommonBancas.map(b => [b.id, b]));
  const examinerMap = new Map(input.examiners.map(ex => [ex.id, ex]));

  const newBancas: NewAutoCnhBanca[] = [];
  const schoolUpdates: { schoolId: string; mainSchedule: any }[] = [];

  const eligibleSchools = input.schools
    .filter(isSchoolEligibleForCnhAutoBancas)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id));

  for (const school of eligibleSchools) {
    const main = school.mainSchedule!;
    const config = main.rotationConfig!;
    const synced = syncRollingRotationSchedule({
      schoolCity: school.city,
      config,
      existingEntries: main.rotationEntries ?? [],
      suppressedDates: main.suppressedRotationDates ?? [],
      pausedDates: main.pausedDates ?? [],
      examiners: input.examiners,
      cities: input.cities,
      blockedDates,
      systemSettings,
      today,
      createId,
    });

    const entries = [...synced.entries].sort(
      (a, b) => dateOnly(a.date).localeCompare(dateOnly(b.date)) || normalizeScaleTime(a.time).localeCompare(normalizeScaleTime(b.time)),
    );

    const rawLinks: AutoCnhBancaLink[] = Array.isArray(main.autoCnhBancaLinks) ? main.autoCnhBancaLinks : [];
    const cleanedLinks: AutoCnhBancaLink[] = [];
    const linkedIds = new Set<string>();

    for (const link of rawLinks) {
      if (!link?.scheduleId) continue;
      const existing = commonById.get(link.scheduleId);
      if (!existing) continue;
      if (linkedIds.has(existing.id)) continue;
      linkedIds.add(existing.id);
      cleanedLinks.push({
        scheduleId: existing.id,
        date: dateOnly(existing.date),
        time: normalizeScaleTime(existing.time),
        ...(link.entryId ? { entryId: link.entryId } : {}),
      });
    }

    // Adota bancas já criadas manualmente (sem alterá-las) que coincidam exatamente com (data, horário) da escala
    for (const entry of entries) {
      const entryDate = dateOnly(entry.date);
      const entryTime = normalizeScaleTime(entry.time);
      if (!isCalendarDate(entryDate) || !isValidScaleTime(entryTime)) continue;
      const existingMatch = workingCommonBancas.find(
        b => b.status !== 'CANCELLED' && dateOnly(b.date) === entryDate && normalizeScaleTime(b.time) === entryTime,
      );
      if (existingMatch && !linkedIds.has(existingMatch.id)) {
        linkedIds.add(existingMatch.id);
        cleanedLinks.push({
          scheduleId: existingMatch.id,
          date: dateOnly(existingMatch.date),
          time: normalizeScaleTime(existingMatch.time),
          ...(entry.id ? { entryId: entry.id } : {}),
        });
      }
    }

    const linkedBancas = cleanedLinks.map(l => commonById.get(l.scheduleId)!).filter(Boolean);
    const openCount = linkedBancas.filter(b => b.status === 'OPEN').length;
    let needed = Math.max(0, targetOpenPerSchool - openCount);

    const pausedSet = new Set((main.pausedDates ?? []).filter(isCalendarDate));
    const suppressedSet = new Set((synced.suppressedDates ?? []).filter(isCalendarDate));

    const cityId = resolveCityIdByName(school.city, input.cities);
    const matchingLocations = cityId ? examLocations.filter(loc => loc.cityId === cityId) : [];
    const resolvedLocationId = matchingLocations.length === 1 ? matchingLocations[0].id : null;

    if (needed > 0) {
      for (const entry of entries) {
        if (needed <= 0) break;

        const entryDate = dateOnly(entry.date);
        const entryTime = normalizeScaleTime(entry.time);
        if (!isCalendarDate(entryDate) || !isValidScaleTime(entryTime) || entryDate < today) continue;
        if (pausedSet.has(entryDate) || suppressedSet.has(entryDate)) continue;
        if (isSystemDateBlockedForRotation(entryDate, blockedDates, systemSettings).blocked) continue;
        if (calculateScheduleStatus(entryDate, entryTime, 'OPEN', now) !== 'OPEN') continue;

        // Já existe banca vinculada para esta data nesta autoescola (aberta, fechada, concluída ou cancelada)
        if (
          cleanedLinks.some(
            l =>
              (entry.id && l.entryId === entry.id) ||
              dateOnly(commonById.get(l.scheduleId)?.date ?? l.date) === entryDate,
          )
        ) {
          continue;
        }

        // Já existe qualquer banca CNH (inclusive cancelada/fechada/manual) nesta mesma data e horário
        if (
          workingCommonBancas.some(
            b => dateOnly(b.date) === entryDate && normalizeScaleTime(b.time) === entryTime,
          )
        ) {
          continue;
        }

        const examiner =
          examinerMap.get(entry.examiner) ??
          input.examiners.find(ex => ex.name === entry.examiner);
        if (!examiner) continue;
        if (isExaminerBlockedOnDateTime(examiner.blockedPeriods, entryDate, entryTime).blocked) continue;

        if (
          cnhBancaConflict(
            { type: 'COMMON', status: 'OPEN', date: entryDate, time: entryTime },
            workingCommonBancas,
          )
        ) {
          continue;
        }

        maxCode += 1;
        const created: NewAutoCnhBanca = {
          id: createId(),
          code: `B${maxCode}`,
          date: entryDate,
          time: entryTime,
          examinerIds: [examiner.id],
          maxSlotsA: examiner.defaultMaxSlotsA ?? systemSettings?.defaultMaxSlotsA ?? 10,
          maxSlotsB: examiner.defaultMaxSlotsB ?? systemSettings?.defaultMaxSlotsB ?? 10,
          type: 'COMMON',
          status: 'OPEN',
          locationId: resolvedLocationId,
        };

        newBancas.push(created);
        workingCommonBancas.push(created);
        commonById.set(created.id, created);
        linkedIds.add(created.id);
        cleanedLinks.push({
          scheduleId: created.id,
          date: created.date,
          time: created.time,
          ...(entry.id ? { entryId: entry.id } : {}),
        });
        needed -= 1;
      }
    }

    const linksChanged = serializeLinks(rawLinks) !== serializeLinks(cleanedLinks);
    if (synced.changed || linksChanged) {
      schoolUpdates.push({
        schoolId: school.id,
        mainSchedule: {
          ...main,
          rotationEntries: entries,
          suppressedRotationDates: synced.suppressedDates,
          autoCnhBancaLinks: cleanedLinks,
        },
      });
    }
  }

  return { newBancas, schoolUpdates };
}

export function mergePreservedAutoCnhBancaLinks(
  incomingMainSchedule: any,
  existingMainSchedule: any,
): any {
  if (!incomingMainSchedule || typeof incomingMainSchedule !== 'object') return incomingMainSchedule;
  if (
    Array.isArray(existingMainSchedule?.autoCnhBancaLinks) &&
    incomingMainSchedule.autoCnhBancaLinks === undefined
  ) {
    return {
      ...incomingMainSchedule,
      autoCnhBancaLinks: existingMainSchedule.autoCnhBancaLinks,
    };
  }
  return incomingMainSchedule;
}

let _syncMutex: Promise<void> = Promise.resolve();

export async function syncCnhRotationBancasOnDb(
  db: any,
  tables: {
    drivingSchools: any;
    examSchedules: any;
    examiners: any;
    cities: any;
    examLocations: any;
    blockedDates: any;
    systemSettings: any;
  },
  options?: {
    preloadedSchedules?: any[];
    now?: Date;
  },
): Promise<{ created: any[]; schedules: any[] }> {
  let result: { created: any[]; schedules: any[] } = {
    created: [],
    schedules: options?.preloadedSchedules ?? [],
  };

  const run = async () => {
    const schools = await db.select().from(tables.drivingSchools);
    const hasEligible = schools.some(isSchoolEligibleForCnhAutoBancas);
    const baseSchedules = options?.preloadedSchedules ?? (await db.select().from(tables.examSchedules));

    if (!hasEligible) {
      result = { created: [], schedules: baseSchedules };
      return;
    }

    const [examinerRows, cityRows, locationRows, blockedRows, settingsRows] = await Promise.all([
      db.select().from(tables.examiners),
      db.select().from(tables.cities),
      db.select().from(tables.examLocations),
      db.select().from(tables.blockedDates),
      db.select().from(tables.systemSettings),
    ]);

    const now = options?.now ?? new Date();
    const plan = planCnhRotationBancas({
      schools,
      schedules: baseSchedules,
      examiners: examinerRows,
      cities: cityRows,
      examLocations: locationRows,
      blockedDates: blockedRows,
      systemSettings: settingsRows[0] ?? null,
      now,
    });

    const insertedRows: any[] = [];
    for (const banca of plan.newBancas) {
      const inserted = await db.insert(tables.examSchedules).values(banca).returning();
      if (inserted?.[0]) insertedRows.push(inserted[0]);
      else insertedRows.push(banca);
    }

    for (const u of plan.schoolUpdates) {
      await db
        .update(tables.drivingSchools)
        .set({ mainSchedule: u.mainSchedule })
        .where(eq(tables.drivingSchools.id, u.schoolId));
    }

    result = {
      created: insertedRows,
      schedules: [...baseSchedules, ...insertedRows],
    };
  };

  const next = _syncMutex.then(run, run);
  _syncMutex = next.then(() => undefined, () => undefined);
  await next;
  return result;
}
