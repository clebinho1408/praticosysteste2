import { eq } from 'drizzle-orm';
import {
  filterUpcomingExaminerRotationDates,
  validateExaminerRotationDatesUpdate,
  type ExaminerRotationDateSlot,
} from './_school-rotation.js';
import { businessDate } from './_school-schedule.js';

export async function applyExaminerSelfRotationUpdate(
  db: any,
  tables: { examiners: any; blockedDates: any; systemSettings: any },
  examinerId: string,
  incomingAvailability: any,
  now = new Date(),
): Promise<{ status: number; error?: string; updated?: any }> {
  const today = businessDate(now);
  const [examinerRows, blockedRows, settingsRows] = await Promise.all([
    db.select().from(tables.examiners).where(eq(tables.examiners.id, examinerId)).limit(1),
    db.select().from(tables.blockedDates),
    db.select().from(tables.systemSettings),
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
    today,
    now,
  });

  if (!check.ok) {
    return { status: 400, error: check.error };
  }

  const nextAvailability = {
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
  const cityIds = Array.isArray(incomingAvailability.cityIds)
    ? incomingAvailability.cityIds.filter((c: unknown) => typeof c === 'string' && c.trim())
    : [];

  const rawDates = Array.isArray(incomingAvailability.availableDates)
    ? incomingAvailability.availableDates
    : Array.isArray(storedAvailability?.availableDates)
      ? storedAvailability.availableDates
      : undefined;

  if (rawDates !== undefined) {
    return {
      cityIds,
      availableDates: filterUpcomingExaminerRotationDates(rawDates, today),
    };
  }

  return {
    ...incomingAvailability,
    cityIds,
  };
}
