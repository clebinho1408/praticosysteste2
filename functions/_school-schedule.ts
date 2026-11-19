/** Calendar dates, not instants: a pause never changes the schedule's active flag. */
export function businessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function mainSchedulePaused(school: {
  provisionalSchedule?: { active?: boolean } | null;
  mainSchedule?: { pausedDates?: string[] } | null;
}, date: string): boolean {
  return !school.provisionalSchedule?.active &&
    !!school.mainSchedule?.pausedDates?.includes(date);
}

export function schoolPauseValidation(body: any): string | null {
  const dates = body?.mainSchedule?.pausedDates;
  if (dates === undefined) return null;
  if (!Array.isArray(dates) || dates.some(date => !isCalendarDate(date)) ||
      new Set(dates).size !== dates.length) {
    return 'Informe datas válidas e sem repetição para pausar a Escala Principal.';
  }
  return null;
}

export function visibleProvisionalDates<T extends { date: string; id?: string }>(
  dates: T[], today: string, draftIds: ReadonlySet<string> = new Set(),
): T[] {
  // Native date inputs can emit an incomplete year while typing. Never unmount
  // an in-progress row just because that intermediate value sorts before today.
  return dates.filter(entry => !entry.date || entry.date >= today || (!!entry.id && draftIds.has(entry.id)));
}

export type SchoolScaleFilter = '' | 'MAIN' | 'PROVISIONAL';

export function activeSchoolScale(school: {
  mainSchedule?: { active?: boolean } | null;
  provisionalSchedule?: { active?: boolean } | null;
}): 'MAIN' | 'PROVISIONAL' | null {
  if (school.provisionalSchedule?.active) return 'PROVISIONAL';
  if (school.mainSchedule?.active) return 'MAIN';
  return null;
}

export function matchesSchoolScale(school: {
  mainSchedule?: { active?: boolean } | null;
  provisionalSchedule?: { active?: boolean } | null;
}, filter: SchoolScaleFilter): boolean {
  if (!filter) return true;
  return activeSchoolScale(school) === filter;
}

const WEEKDAYS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'] as const;

export type ScaleSlotLike = { day?: string | null; time?: string | null; examiner?: string | null };
export type ScaleSpecificDateLike = { id?: string; date?: string | null; time?: string | null; examiner?: string | null };
export type RotationConfigLike = {
  days: string[];
  startTime: string;
  endTime: string;
};
export type RotationEntryLike = {
  id?: string;
  date?: string | null;
  time?: string | null;
  examiner?: string | null;
  manual?: boolean;
};
export type SchoolScheduleLike = {
  active?: boolean;
  frequency?: string;
  days?: string[];
  slots?: ScaleSlotLike[];
  specificDates?: ScaleSpecificDateLike[];
  pausedDates?: string[];
  activateFrom?: string;
  rotationConfig?: RotationConfigLike | null;
  rotationEntries?: RotationEntryLike[] | null;
  suppressedRotationDates?: string[] | null;
};

export function scaleWeekday(date: string): string {
  if (!isCalendarDate(date)) return '';
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

export function normalizeScaleTime(value?: string | null): string {
  const trimmed = String(value ?? '').trim();
  const match = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/.exec(trimmed);
  if (!match) return trimmed;
  const hour = Number(match[1]);
  if (hour < 0 || hour > 23) return trimmed;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

export function isValidScaleTime(value?: string | null): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalizeScaleTime(value));
}

export function usesProvisionalSpecificDates(provisional?: SchoolScheduleLike | null): boolean {
  if (!provisional?.active) return false;
  const hasSpecificDates = Array.isArray(provisional.specificDates) && provisional.specificDates.length > 0;
  const hasLegacyDaysSlots = (provisional.days?.length ?? 0) > 0 && (provisional.slots?.length ?? 0) > 0;
  return hasSpecificDates || !hasLegacyDaysSlots;
}

export function activeFixedSchedule<T extends SchoolScheduleLike>(school: {
  mainSchedule?: T | null;
  provisionalSchedule?: T | null;
}): T | null {
  return school.provisionalSchedule?.active
    ? school.provisionalSchedule
    : school.mainSchedule?.active ? school.mainSchedule : null;
}

export type ResolvedSchoolScale<T extends SchoolScheduleLike = SchoolScheduleLike> =
  | { kind: 'PAUSED' }
  | { kind: 'PROVISIONAL_DATES'; schedule: T; specificDates: { date: string; time: string; examiner: string }[] }
  | { kind: 'ROTATION_DATES'; schedule: T; entries: { date: string; time: string; examiner: string }[] }
  | { kind: 'WEEKLY_SLOTS'; schedule: T; day: string; slots: { day: string; time: string; examiner: string }[] }
  | { kind: 'INACTIVE'; day: string };

export function resolveSchoolScaleForDate<T extends SchoolScheduleLike>(
  school: { examRotation?: boolean; mainSchedule?: T | null; provisionalSchedule?: T | null },
  date: string,
): ResolvedSchoolScale<T> {
  const day = scaleWeekday(date);
  if (usesProvisionalSpecificDates(school.provisionalSchedule)) {
    const prov = school.provisionalSchedule!;
    const specificDates = (prov.specificDates ?? [])
      .filter(d => d.date === date && !!String(d.examiner ?? '').trim() && isValidScaleTime(d.time))
      .map(d => ({
        date,
        time: normalizeScaleTime(d.time),
        examiner: String(d.examiner ?? '').trim(),
      }));
    return { kind: 'PROVISIONAL_DATES', schedule: prov, specificDates };
  }
  if (mainSchedulePaused(school, date)) {
    return { kind: 'PAUSED' };
  }
  if (
    !school.provisionalSchedule?.active &&
    school.examRotation &&
    school.mainSchedule?.active &&
    school.mainSchedule.rotationConfig &&
    Array.isArray(school.mainSchedule.rotationEntries)
  ) {
    const entries = school.mainSchedule.rotationEntries
      .filter(entry => entry.date === date && !!String(entry.examiner ?? '').trim() && isValidScaleTime(entry.time))
      .map(entry => ({
        date,
        time: normalizeScaleTime(entry.time),
        examiner: String(entry.examiner ?? '').trim(),
      }));
    return { kind: 'ROTATION_DATES', schedule: school.mainSchedule, entries };
  }
  const schedule = activeFixedSchedule(school);
  if (!day || !schedule?.days?.includes(day)) {
    return { kind: 'INACTIVE', day };
  }
  const slots = (schedule.slots ?? [])
    .filter(s => {
      const slotDay = String(s.day ?? '').trim();
      return !slotDay || slotDay === day;
    })
    .map(s => ({
      day: String(s.day ?? '').trim(),
      time: normalizeScaleTime(s.time),
      examiner: String(s.examiner ?? '').trim(),
    }));
  return { kind: 'WEEKLY_SLOTS', schedule, day, slots };
}
