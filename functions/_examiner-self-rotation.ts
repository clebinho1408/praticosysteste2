import { eq } from 'drizzle-orm';
import {
  filterUpcomingExaminerRotationDates,
  validateExaminerRotationDatesUpdate,
  type ExaminerRotationDateSlot,
} from './_school-rotation.js';
import {
  businessDate,
  isCalendarDate,
  isValidScaleTime,
  normalizeScaleTime,
} from './_school-schedule.js';

export async function applyExaminerSelfRotationUpdate(
  db: any,
  tables: { examiners: any; blockedDates: any; systemSettings: any; drivingSchools?: any; cities?: any },
  examinerId: string,
  incomingAvailability: any,
  now = new Date(),
): Promise<{ status: number; error?: string; updated?: any }> {
  const today = businessDate(now);
  const [examinerRows, blockedRows, settingsRows, schoolRows, cityRows] = await Promise.all([
    db.select().from(tables.examiners).where(eq(tables.examiners.id, examinerId)).limit(1),
    db.select().from(tables.blockedDates),
    db.select().from(tables.systemSettings),
    tables.drivingSchools ? db.select().from(tables.drivingSchools) : Promise.resolve([]),
    tables.cities ? db.select().from(tables.cities) : Promise.resolve([]),
  ]);

  const current = examinerRows[0];
  if (!current) {
    return { status: 404, error: 'Examinador não encontrado.' };
  }
  if (!current.examRotation) {
    return { status: 403, error: 'Seu perfil não está marcado para participar do Rodízio de Provas.' };
  }

  const nextSlots = incomingAvailability?.availableDates as ExaminerRotationDateSlot[];
  const existingSlots = Array.isArray(current.rotationAvailability?.availableDates)
    ? current.rotationAvailability.availableDates
    : [];

  const check = validateExaminerRotationDatesUpdate({
    existingSlots,
    nextSlots,
    blockedDates: blockedRows ?? [],
    systemSettings: settingsRows?.[0] ?? null,
    examinerSchoolIds: Array.isArray(current.rotationAvailability?.schoolIds)
      ? current.rotationAvailability.schoolIds
      : undefined,
    examinerCityIds: Array.isArray(current.rotationAvailability?.cityIds)
      ? current.rotationAvailability.cityIds
      : undefined,
    schools: schoolRows ?? [],
    cities: cityRows ?? [],
    today,
    now,
  });

  if (!check.ok) {
    return { status: 400, error: check.error };
  }

  const nextAvailability = {
    ...(Array.isArray(current.rotationAvailability?.schoolIds)
      ? { schoolIds: current.rotationAvailability.schoolIds }
      : {}),
    cityIds: Array.isArray(current.rotationAvailability?.cityIds)
      ? current.rotationAvailability.cityIds
      : [],
    availableDates: check.availableDates,
  };

  const updatedRows = await db
    .update(tables.examiners)
    .set({ rotationAvailability: nextAvailability })
    .where(eq(tables.examiners.id, examinerId))
    .returning();

  return { status: 200, updated: updatedRows[0] };
}

export function sanitizeAdminExaminerRotationAvailability(
  incomingAvailability: any,
  storedAvailability?: any,
  today = businessDate(),
) {
  if (!incomingAvailability || typeof incomingAvailability !== 'object') {
    return incomingAvailability ?? null;
  }
  const schoolIds = Array.isArray(incomingAvailability.schoolIds)
    ? Array.from(
        new Set(
          incomingAvailability.schoolIds
            .filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
            .map((s: string) => s.trim()),
        ),
      )
    : Array.isArray(storedAvailability?.schoolIds)
      ? storedAvailability.schoolIds
      : undefined;

  const cityIds = Array.isArray(incomingAvailability.cityIds)
    ? incomingAvailability.cityIds.filter((c: unknown) => typeof c === 'string' && c.trim())
    : [];

  const rawDates = Array.isArray(incomingAvailability.availableDates)
    ? incomingAvailability.availableDates
    : Array.isArray(storedAvailability?.availableDates)
      ? storedAvailability.availableDates
      : undefined;

  if (rawDates !== undefined) {
    const nowIso = new Date().toISOString();
    const deduped: ExaminerRotationDateSlot[] = [];
    const seenDt = new Set<string>();
    if (Array.isArray(rawDates)) {
      for (const raw of rawDates) {
        if (!raw || typeof raw !== 'object') continue;
        const cleanDate = String(raw.date ?? '').split('T')[0].trim();
        const cleanTime = normalizeScaleTime(raw.time);
        if (!isCalendarDate(cleanDate) || cleanDate < today || !isValidScaleTime(cleanTime)) continue;
        const dtKey = `${cleanDate}|${cleanTime}`;
        if (seenDt.has(dtKey)) continue;
        seenDt.add(dtKey);
        deduped.push({
          id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : crypto.randomUUID(),
          date: cleanDate,
          time: cleanTime,
          createdAt: typeof raw.createdAt === 'string' && raw.createdAt.trim() ? raw.createdAt : nowIso,
        });
      }
    }
    return {
      ...(schoolIds !== undefined ? { schoolIds } : {}),
      cityIds,
      availableDates: filterUpcomingExaminerRotationDates(deduped, today),
    };
  }

  return {
    ...incomingAvailability,
    ...(schoolIds !== undefined ? { schoolIds } : {}),
    cityIds,
  };
}
