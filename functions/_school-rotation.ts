import {
  businessDate,
  isCalendarDate,
  isValidScaleTime,
  normalizeScaleTime,
  resolveSchoolScaleForDate,
  scaleWeekday,
} from './_school-schedule.js';

export interface RotationConfig {
  days: string[];
  startTime: string;
  endTime: string;
}

export interface RotationScheduleEntry {
  id: string;
  date: string;
  time: string;
  examiner: string;
  manual?: boolean;
}

export interface ExaminerRotationDateSlot {
  id: string;
  date: string;      // 'YYYY-MM-DD'
  time: string;      // 'HH:mm'
  createdAt: string; // ISO timestamp
}

export interface RotationBlockedPeriodLike {
  id?: string;
  startDate: string;
  endDate: string;
  description?: string;
  period?: 'ALL_DAY' | 'MORNING' | 'AFTERNOON' | string;
}

export interface RotationExaminerLike {
  id: string;
  name: string;
  canExamCommon?: boolean | null;
  examRotation?: boolean | null;
  rotationAvailability?: {
    cityIds: string[];
    availableDates?: ExaminerRotationDateSlot[];
    days?: string[];
    defaultTime?: string;
    secondDefaultTime?: string;
    examsPerDay?: 1 | 2;
  } | null;
  blockedPeriods?: RotationBlockedPeriodLike[] | null;
}

export interface RotationCityLike {
  id: string;
  name: string;
}

export interface RotationBlockedDateLike {
  date: string;
  description?: string;
}

export interface RotationSystemSettingsLike {
  blockWeekends?: boolean;
}

export function addCalendarDays(date: string, days: number): string {
  const base = new Date(`${date}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function diffCalendarDays(earlierIso: string, laterIso: string): number {
  if (!isCalendarDate(earlierIso) || !isCalendarDate(laterIso)) return 0;
  const [ey, em, ed] = earlierIso.split('-').map(Number);
  const [ly, lm, ld] = laterIso.split('-').map(Number);
  return Math.round((Date.UTC(ly, lm - 1, ld) - Date.UTC(ey, em - 1, ed)) / 86400000);
}

export function listForwardDates(startDate: string, horizonDays = 30): string[] {
  if (!isCalendarDate(startDate) || horizonDays < 0) return [];
  const dates: string[] = [];
  for (let i = 0; i <= horizonDays; i++) {
    dates.push(addCalendarDays(startDate, i));
  }
  return dates;
}

export function formatRotationDateBR(iso: string): string {
  if (!isCalendarDate(iso)) return iso || '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export function isTimeWithinWindow(time: string, startTime: string, endTime: string): boolean {
  const t = normalizeScaleTime(time);
  const start = normalizeScaleTime(startTime);
  const end = normalizeScaleTime(endTime);
  if (!isValidScaleTime(t) || !isValidScaleTime(start) || !isValidScaleTime(end)) return false;
  return t >= start && t <= end;
}

export function isExaminerBlockedOnDateTime(
  blockedPeriods: RotationBlockedPeriodLike[] | undefined | null,
  date: string,
  time?: string,
): { blocked: boolean; reason?: string } {
  if (!isCalendarDate(date) || !Array.isArray(blockedPeriods) || blockedPeriods.length === 0) {
    return { blocked: false };
  }
  const normalizedTime = normalizeScaleTime(time);
  const hasTime = isValidScaleTime(normalizedTime);
  const [hh, mm] = hasTime ? normalizedTime.split(':').map(Number) : [0, 0];
  const totalMinutes = hh * 60 + mm;

  const match = blockedPeriods.find(p => {
    if (!p?.startDate || !p?.endDate) return false;
    if (date < p.startDate || date > p.endDate) return false;
    if (!p.period || p.period === 'ALL_DAY') return true;
    if (!hasTime) return true;
    if (p.period === 'MORNING') return totalMinutes < 12 * 60;
    if (p.period === 'AFTERNOON') return totalMinutes >= 12 * 60;
    return true;
  });

  if (!match) return { blocked: false };
  const turno = match.period === 'MORNING' ? ' (manhã)' : match.period === 'AFTERNOON' ? ' (tarde)' : '';
  const reason = match.description ? `${match.description}${turno}` : `Afastamento / Férias${turno}`;
  return { blocked: true, reason };
}

export function isSystemDateBlockedForRotation(
  date: string,
  blockedDates: RotationBlockedDateLike[] = [],
  settings?: RotationSystemSettingsLike | null,
): { blocked: boolean; reason?: string } {
  if (!isCalendarDate(date)) return { blocked: false };
  const weekday = scaleWeekday(date);
  if (settings?.blockWeekends && (weekday === 'DOM' || weekday === 'SAB')) {
    return { blocked: true, reason: 'Finais de semana estão bloqueados.' };
  }
  const found = blockedDates.find(b => b.date?.split('T')[0] === date);
  if (found) {
    return { blocked: true, reason: found.description || 'Data bloqueada / Feriado' };
  }
  return { blocked: false };
}

export function resolveCityIdByName(schoolCity: string | undefined | null, cities: RotationCityLike[]): string | null {
  const target = String(schoolCity ?? '').trim().toUpperCase();
  if (!target) return null;
  const match = cities.find(c => c.name.trim().toUpperCase() === target);
  return match?.id ?? null;
}

export const MAX_ROTATION_AVAILABILITY_DAYS = 60;
export const ROTATION_EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;

export function filterUpcomingExaminerRotationDates(
  slots: ExaminerRotationDateSlot[] | null | undefined,
  today = businessDate(),
): ExaminerRotationDateSlot[] {
  if (!Array.isArray(slots) || !isCalendarDate(today)) return [];
  return slots
    .filter((s): s is ExaminerRotationDateSlot =>
      Boolean(s && isCalendarDate(s.date) && s.date >= today && isValidScaleTime(normalizeScaleTime(s.time))),
    )
    .map(s => ({
      ...s,
      time: normalizeScaleTime(s.time),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
}

export function isRotationDateSlotEditable(
  slot: Pick<ExaminerRotationDateSlot, 'createdAt'> | null | undefined,
  now = new Date(),
): { editable: boolean; remainingMs: number; remainingHours: number; reason?: string } {
  const createdMs = slot?.createdAt ? Date.parse(slot.createdAt) : Number.NaN;
  if (!Number.isFinite(createdMs)) {
    return {
      editable: false,
      remainingMs: 0,
      remainingHours: 0,
      reason: 'Prazo de 48h expirado (sem data de registro válida).',
    };
  }
  const elapsed = now.getTime() - createdMs;
  if (elapsed > ROTATION_EDIT_WINDOW_MS) {
    return {
      editable: false,
      remainingMs: 0,
      remainingHours: 0,
      reason: 'Prazo de 48h após o cadastro expirado para editar ou excluir.',
    };
  }
  const remainingMs = Math.max(0, ROTATION_EDIT_WINDOW_MS - Math.max(0, elapsed));
  return {
    editable: true,
    remainingMs,
    remainingHours: Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000))),
  };
}

export function validateExaminerRotationDatesUpdate(input: {
  existingSlots?: ExaminerRotationDateSlot[] | null;
  nextSlots: ExaminerRotationDateSlot[];
  blockedDates?: RotationBlockedDateLike[];
  systemSettings?: RotationSystemSettingsLike | null;
  today?: string;
  now?: Date;
  maxDaysAhead?: number;
  createId?: () => string;
}): { ok: true; availableDates: ExaminerRotationDateSlot[] } | { ok: false; error: string } {
  const now = input.now ?? new Date();
  const today = input.today && isCalendarDate(input.today) ? input.today : businessDate(now);
  const maxDaysAhead = input.maxDaysAhead ?? MAX_ROTATION_AVAILABILITY_DAYS;
  const maxDate = addCalendarDays(today, maxDaysAhead);
  const blockedDates = input.blockedDates ?? [];
  const createId = input.createId ?? (() => crypto.randomUUID());

  if (!Array.isArray(input.nextSlots)) {
    return { ok: false, error: 'Lista de datas e horários inválida.' };
  }

  const existingUpcoming = filterUpcomingExaminerRotationDates(input.existingSlots, today);
  const existingById = new Map(existingUpcoming.map(s => [s.id, s]));
  const incomingById = new Map<string, ExaminerRotationDateSlot>();
  for (const item of input.nextSlots) {
    if (item?.id) incomingById.set(item.id, item);
  }

  for (const stored of existingUpcoming) {
    const windowState = isRotationDateSlotEditable(stored, now);
    if (windowState.editable) continue;
    const matched = incomingById.get(stored.id);
    if (
      !matched ||
      matched.date !== stored.date ||
      normalizeScaleTime(matched.time) !== normalizeScaleTime(stored.time)
    ) {
      return {
        ok: false,
        error: `A disponibilidade de ${formatRotationDateBR(stored.date)} às ${normalizeScaleTime(stored.time)} já ultrapassou 48h do cadastro e não pode ser editada ou excluída.`,
      };
    }
  }

  const seenDateTime = new Set<string>();
  const validated: ExaminerRotationDateSlot[] = [];

  for (const raw of input.nextSlots) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Item de disponibilidade inválido.' };
    }
    const stored = raw.id ? existingById.get(raw.id) : undefined;
    const date = String(raw.date ?? '').split('T')[0].trim();
    const time = normalizeScaleTime(raw.time);

    // Se um registro já existente venceu (passou para antes de hoje), oculta/descarta automaticamente.
    if (stored && isCalendarDate(date) && date < today) {
      continue;
    }
    if (!isCalendarDate(date)) {
      return { ok: false, error: 'Informe uma data válida para todas as disponibilidades.' };
    }
    if (date < today) {
      return { ok: false, error: `A data ${formatRotationDateBR(date)} já passou e não pode ser cadastrada.` };
    }
    if (!isValidScaleTime(time)) {
      return { ok: false, error: `Informe um horário válido para ${formatRotationDateBR(date)}.` };
    }

    const isLockedStored = stored && !isRotationDateSlotEditable(stored, now).editable;
    const dateChanged = !stored || stored.date !== date;

    if (!isLockedStored && date > maxDate) {
      return {
        ok: false,
        error: `As datas devem estar entre hoje e no máximo ${maxDaysAhead} dias no futuro (até ${formatRotationDateBR(maxDate)}).`,
      };
    }

    if (dateChanged) {
      const blockCheck = isSystemDateBlockedForRotation(date, blockedDates, input.systemSettings);
      if (blockCheck.blocked) {
        return {
          ok: false,
          error: `A data ${formatRotationDateBR(date)} está bloqueada (${blockCheck.reason}).`,
        };
      }
    }

    const dtKey = `${date}|${time}`;
    if (seenDateTime.has(dtKey)) {
      return {
        ok: false,
        error: `Horário duplicado em ${formatRotationDateBR(date)} às ${time}.`,
      };
    }
    seenDateTime.add(dtKey);

    validated.push({
      id: stored ? stored.id : (typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : createId()),
      date,
      time,
      createdAt: stored ? stored.createdAt : now.toISOString(),
    });
  }

  validated.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  return { ok: true, availableDates: validated };
}

export function usesExplicitRotationDates(examiner: RotationExaminerLike | null | undefined): boolean {
  return Array.isArray(examiner?.rotationAvailability?.availableDates);
}

export function getExaminerRotationTimesInWindow(
  examiner: RotationExaminerLike,
  config: RotationConfig,
  today = businessDate(),
): string[] {
  const av = examiner.rotationAvailability;
  if (!av) return [];
  if (Array.isArray(av.availableDates)) {
    const configDays = new Set(config.days ?? []);
    const unique = new Set<string>();
    for (const slot of filterUpcomingExaminerRotationDates(av.availableDates, today)) {
      if (configDays.size > 0 && !configDays.has(scaleWeekday(slot.date))) continue;
      if (isTimeWithinWindow(slot.time, config.startTime, config.endTime)) {
        unique.add(slot.time);
      }
    }
    return [...unique];
  }
  const rawTimes = av.examsPerDay === 2
    ? [av.defaultTime ?? '', av.secondDefaultTime ?? '']
    : [av.defaultTime ?? ''];
  const unique = new Set<string>();
  for (const raw of rawTimes) {
    const t = normalizeScaleTime(raw);
    if (isValidScaleTime(t) && isTimeWithinWindow(t, config.startTime, config.endTime)) {
      unique.add(t);
    }
  }
  return [...unique];
}

export function getExaminerRotationTimesForDate(
  examiner: RotationExaminerLike,
  date: string,
  config?: RotationConfig | null,
): string[] {
  const av = examiner.rotationAvailability;
  if (!av || !isCalendarDate(date)) return [];
  if (Array.isArray(av.availableDates)) {
    const unique = new Set<string>();
    for (const slot of av.availableDates) {
      if (!slot || slot.date !== date) continue;
      const t = normalizeScaleTime(slot.time);
      if (!isValidScaleTime(t)) continue;
      if (config && !isTimeWithinWindow(t, config.startTime, config.endTime)) continue;
      unique.add(t);
    }
    return [...unique].sort();
  }
  const weekday = scaleWeekday(date);
  if (!Array.isArray(av.days) || !av.days.includes(weekday)) return [];
  if (config) return getExaminerRotationTimesInWindow(examiner, config);
  const rawTimes = av.examsPerDay === 2
    ? [av.defaultTime ?? '', av.secondDefaultTime ?? '']
    : [av.defaultTime ?? ''];
  const unique = new Set<string>();
  for (const raw of rawTimes) {
    const t = normalizeScaleTime(raw);
    if (isValidScaleTime(t)) unique.add(t);
  }
  return [...unique];
}

export function getExaminerMaxPerDayForDate(
  examiner: RotationExaminerLike | null | undefined,
  date: string,
): number {
  const av = examiner?.rotationAvailability;
  if (!av) return 1;
  if (Array.isArray(av.availableDates)) {
    const times = getExaminerRotationTimesForDate(examiner!, date);
    return times.length;
  }
  return av.examsPerDay === 2 ? 2 : 1;
}

export function resolveExaminerDefaultRotationTime(
  examiner: RotationExaminerLike | null | undefined,
  config?: RotationConfig | null,
  date?: string,
  today = businessDate(),
): string | null {
  const av = examiner?.rotationAvailability;
  if (!av) return null;

  if (Array.isArray(av.availableDates)) {
    const upcoming = filterUpcomingExaminerRotationDates(av.availableDates, today);
    const matching = date && isCalendarDate(date)
      ? upcoming.filter(s => s.date === date)
      : upcoming;
    const inWindow = config
      ? matching.filter(s => isTimeWithinWindow(s.time, config.startTime, config.endTime))
      : matching;
    const pool = (inWindow.length > 0 ? inWindow : matching).map(s => s.time);
    if (pool.length === 0) return null;
    if (date && isCalendarDate(date)) {
      const unblocked = pool.find(
        t => !isExaminerBlockedOnDateTime(examiner?.blockedPeriods, date, t).blocked,
      );
      if (unblocked) return unblocked;
    }
    return pool[0];
  }

  const rawCandidates = av.examsPerDay === 2
    ? [av.defaultTime ?? '', av.secondDefaultTime ?? '']
    : [av.defaultTime ?? ''];
  const allValid: string[] = [];
  for (const raw of rawCandidates) {
    const t = normalizeScaleTime(raw);
    if (isValidScaleTime(t) && !allValid.includes(t)) {
      allValid.push(t);
    }
  }
  if (allValid.length === 0) return null;

  const inWindow = config ? getExaminerRotationTimesInWindow(examiner!, config, today) : [];
  const pool = inWindow.length > 0 ? inWindow : allValid;

  if (date && isCalendarDate(date)) {
    const unblocked = pool.find(
      t => !isExaminerBlockedOnDateTime(examiner?.blockedPeriods, date, t).blocked,
    );
    if (unblocked) return unblocked;
  }

  return pool[0];
}

export function findEligibleExaminersForSchool(input: {
  schoolCity?: string | null;
  config: RotationConfig;
  examiners: RotationExaminerLike[];
  cities: RotationCityLike[];
  today?: string;
}): {
  cityId: string | null;
  eligible: RotationExaminerLike[];
  issue?: string;
} {
  const today = input.today ?? businessDate();
  const cityId = resolveCityIdByName(input.schoolCity, input.cities);
  if (!cityId) {
    return {
      cityId: null,
      eligible: [],
      issue: 'Cidade da autoescola não informada ou não cadastrada para validar o rodízio.',
    };
  }
  const configDays = new Set(input.config.days);
  const eligible = input.examiners.filter(ex => {
    if (!ex.examRotation || ex.canExamCommon === false) return false;
    const av = ex.rotationAvailability;
    if (!av || !Array.isArray(av.cityIds) || !av.cityIds.includes(cityId)) return false;
    if (Array.isArray(av.availableDates)) {
      return getExaminerRotationTimesInWindow(ex, input.config, today).length > 0;
    }
    if (!Array.isArray(av.days) || !av.days.some(d => configDays.has(d))) return false;
    return getExaminerRotationTimesInWindow(ex, input.config, today).length > 0;
  });
  if (eligible.length === 0) {
    return {
      cityId,
      eligible: [],
      issue: 'Nenhum examinador elegível com "Participar do Rodízio de Provas", cidade, datas e horários compatíveis.',
    };
  }
  return { cityId, eligible };
}

export interface OtherSchoolRotationLike {
  id: string;
  name?: string;
  city?: string | null;
  examRotation?: boolean | null;
  mainSchedule?: {
    active?: boolean | null;
    rotationConfig?: RotationConfig | null;
    rotationEntries?: RotationScheduleEntry[] | null;
    suppressedRotationDates?: string[] | null;
    pausedDates?: string[] | null;
    [key: string]: any;
  } | null;
  provisionalSchedule?: {
    active?: boolean | null;
    [key: string]: any;
  } | null;
}

export function isActiveRotationSchool(school: OtherSchoolRotationLike | null | undefined): boolean {
  return Boolean(
    school &&
      school.examRotation &&
      school.mainSchedule?.active &&
      school.mainSchedule?.rotationConfig &&
      !school.provisionalSchedule?.active,
  );
}

/** Retorna a segunda-feira (YYYY-MM-DD) que inicia a semana (SEG..DOM) da data informada. */
export function getRotationWeekKey(date: string): string {
  if (!isCalendarDate(date)) return '';
  const dt = new Date(`${date}T12:00:00Z`);
  const day = dt.getUTCDay(); // 0=DOM, 1=SEG, ..., 6=SAB
  const diffToMonday = day === 0 ? -6 : 1 - day;
  return addCalendarDays(date, diffToMonday);
}

interface CrossSchoolUsageIndex {
  weekSchoolSets: Map<string, Set<string>>;
  weekTotalCounts: Map<string, number>;
  weekSchoolNames: Map<string, Map<string, string>>;
  dateCounts: Map<string, number>;
  dateTimeCounts: Map<string, number>;
}

function buildCrossSchoolUsageIndex(
  otherSchools: OtherSchoolRotationLike[] | null | undefined,
  currentSchoolId?: string | null,
  today?: string,
): CrossSchoolUsageIndex {
  const weekSchoolSets = new Map<string, Set<string>>();
  const weekTotalCounts = new Map<string, number>();
  const weekSchoolNames = new Map<string, Map<string, string>>();
  const dateCounts = new Map<string, number>();
  const dateTimeCounts = new Map<string, number>();

  if (!Array.isArray(otherSchools) || otherSchools.length === 0) {
    return { weekSchoolSets, weekTotalCounts, weekSchoolNames, dateCounts, dateTimeCounts };
  }

  for (const school of otherSchools) {
    if (!school || (currentSchoolId && school.id === currentSchoolId)) continue;
    if (!isActiveRotationSchool(school)) continue;
    const entries = school.mainSchedule?.rotationEntries;
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const schoolLabel = String(school.name || school.id || '').trim() || school.id;

    for (const entry of entries) {
      if (!entry || !isCalendarDate(entry.date) || !entry.examiner) continue;
      if (today && entry.date < today) continue;
      const weekKey = getRotationWeekKey(entry.date);
      const time = normalizeScaleTime(entry.time);
      const weekExKey = `${weekKey}|${entry.examiner}`;

      let schoolSet = weekSchoolSets.get(weekExKey);
      if (!schoolSet) {
        schoolSet = new Set<string>();
        weekSchoolSets.set(weekExKey, schoolSet);
      }
      schoolSet.add(school.id);

      let nameMap = weekSchoolNames.get(weekExKey);
      if (!nameMap) {
        nameMap = new Map<string, string>();
        weekSchoolNames.set(weekExKey, nameMap);
      }
      nameMap.set(school.id, schoolLabel);

      weekTotalCounts.set(weekExKey, (weekTotalCounts.get(weekExKey) ?? 0) + 1);

      const dateExKey = `${entry.date}|${entry.examiner}`;
      dateCounts.set(dateExKey, (dateCounts.get(dateExKey) ?? 0) + 1);

      if (isValidScaleTime(time)) {
        const dtExKey = `${entry.date}|${time}|${entry.examiner}`;
        dateTimeCounts.set(dtExKey, (dateTimeCounts.get(dtExKey) ?? 0) + 1);
      }
    }
  }

  return { weekSchoolSets, weekTotalCounts, weekSchoolNames, dateCounts, dateTimeCounts };
}

export interface CrossSchoolWeeklyRepeat {
  entryId: string;
  date: string;
  weekKey: string;
  examinerId: string;
  otherSchoolIds: string[];
  otherSchoolNames: string[];
}

export function findCrossSchoolWeeklyRepeats(input: {
  entries: RotationScheduleEntry[] | null | undefined;
  otherSchools?: OtherSchoolRotationLike[] | null;
  currentSchoolId?: string | null;
  today?: string;
}): CrossSchoolWeeklyRepeat[] {
  if (!Array.isArray(input.entries) || input.entries.length === 0) return [];
  const index = buildCrossSchoolUsageIndex(input.otherSchools, input.currentSchoolId, input.today);
  const repeats: CrossSchoolWeeklyRepeat[] = [];
  for (const entry of input.entries) {
    if (!entry || !isCalendarDate(entry.date) || !entry.examiner) continue;
    if (input.today && entry.date < input.today) continue;
    const weekKey = getRotationWeekKey(entry.date);
    const weekExKey = `${weekKey}|${entry.examiner}`;
    const nameMap = index.weekSchoolNames.get(weekExKey);
    if (!nameMap || nameMap.size === 0) continue;
    repeats.push({
      entryId: entry.id,
      date: entry.date,
      weekKey,
      examinerId: entry.examiner,
      otherSchoolIds: [...nameMap.keys()],
      otherSchoolNames: [...nameMap.values()],
    });
  }
  return repeats;
}

interface CandidateScore {
  sameDateTime: number;
  exceedsPerDay: number;
  otherWeekPresence: number;
  otherWeekTotal: number;
  otherDateCount: number;
  schoolCount: number;
  thisWeekCount: number;
}

function scoreRotationCandidate(params: {
  examiner: RotationExaminerLike;
  date: string;
  time: string;
  weekKey: string;
  crossIndex: CrossSchoolUsageIndex;
  schoolCounts: Map<string, number>;
  thisWeekCounts: Map<string, number>;
  thisDateCounts: Map<string, number>;
  thisDateTimeCounts: Map<string, number>;
}): CandidateScore {
  const {
    examiner,
    date,
    time,
    weekKey,
    crossIndex,
    schoolCounts,
    thisWeekCounts,
    thisDateCounts,
    thisDateTimeCounts,
  } = params;
  const exId = examiner.id;
  const weekExKey = `${weekKey}|${exId}`;
  const dateExKey = `${date}|${exId}`;
  const dtExKey = `${date}|${time}|${exId}`;

  const otherDt = crossIndex.dateTimeCounts.get(dtExKey) ?? 0;
  const thisDt = thisDateTimeCounts.get(dtExKey) ?? 0;
  const sameDateTime = otherDt + thisDt > 0 ? 1 : 0;

  const otherDateCount = crossIndex.dateCounts.get(dateExKey) ?? 0;
  const thisDateCount = thisDateCounts.get(dateExKey) ?? 0;
  const maxPerDay = getExaminerMaxPerDayForDate(examiner, date);
  const exceedsPerDay = maxPerDay <= 0 || otherDateCount + thisDateCount >= maxPerDay ? 1 : 0;

  const otherWeekPresence = crossIndex.weekSchoolSets.get(weekExKey)?.size ?? 0;
  const otherWeekTotal = crossIndex.weekTotalCounts.get(weekExKey) ?? 0;
  const schoolCount = schoolCounts.get(exId) ?? 0;
  const thisWeekCount = thisWeekCounts.get(weekExKey) ?? 0;

  return {
    sameDateTime,
    exceedsPerDay,
    otherWeekPresence,
    otherWeekTotal,
    otherDateCount,
    schoolCount,
    thisWeekCount,
  };
}

function compareCandidateScores(a: CandidateScore, b: CandidateScore): number {
  return (
    a.sameDateTime - b.sameDateTime ||
    a.exceedsPerDay - b.exceedsPerDay ||
    a.otherWeekPresence - b.otherWeekPresence ||
    a.otherWeekTotal - b.otherWeekTotal ||
    a.otherDateCount - b.otherDateCount ||
    a.schoolCount - b.schoolCount ||
    a.thisWeekCount - b.thisWeekCount
  );
}

export interface SyncRotationScheduleInput {
  currentSchoolId?: string | null;
  schoolCity?: string | null;
  config: RotationConfig;
  existingEntries?: RotationScheduleEntry[] | null;
  suppressedDates?: string[] | null;
  pausedDates?: string[] | null;
  otherSchools?: OtherSchoolRotationLike[] | null;
  examiners: RotationExaminerLike[];
  cities: RotationCityLike[];
  blockedDates?: RotationBlockedDateLike[];
  systemSettings?: RotationSystemSettingsLike | null;
  today?: string;
  horizonDays?: number;
  forceRebalanceAuto?: boolean;
  createId?: () => string;
}

export interface SyncRotationScheduleResult {
  entries: RotationScheduleEntry[];
  suppressedDates: string[];
  warnings: string[];
  distribution: { examinerId: string; examinerName: string; count: number }[];
  changed: boolean;
}

export function syncRollingRotationSchedule(input: SyncRotationScheduleInput): SyncRotationScheduleResult {
  const today = input.today ?? businessDate();
  const horizonDays = input.horizonDays ?? 30;
  const maxDate = addCalendarDays(today, horizonDays);
  const blockedDates = input.blockedDates ?? [];
  const pausedSet = new Set((input.pausedDates ?? []).filter(isCalendarDate));
  const createId = input.createId ?? (() => crypto.randomUUID());

  const normalizedConfig: RotationConfig = {
    days: Array.from(new Set(input.config.days ?? [])),
    startTime: normalizeScaleTime(input.config.startTime),
    endTime: normalizeScaleTime(input.config.endTime),
  };

  const rawSuppressed = Array.isArray(input.suppressedDates) ? input.suppressedDates : [];
  const cleanedSuppressed = Array.from(
    new Set(rawSuppressed.filter(d => isCalendarDate(d) && d >= today && d <= maxDate)),
  ).sort();
  const suppressedSet = new Set(cleanedSuppressed);

  const cityId = resolveCityIdByName(input.schoolCity, input.cities);
  const examinerMap = new Map(input.examiners.map(ex => [ex.id, ex]));
  const crossIndex = buildCrossSchoolUsageIndex(input.otherSchools, input.currentSchoolId, today);
  const hasOtherSchools = crossIndex.weekSchoolSets.size > 0;

  const baseEligibility = findEligibleExaminersForSchool({
    schoolCity: input.schoolCity,
    config: normalizedConfig,
    examiners: input.examiners,
    cities: input.cities,
    today,
  });

  const listCandidatesForDate = (date: string): { examiner: RotationExaminerLike; time: string }[] => {
    if (!cityId) return [];
    const weekday = scaleWeekday(date);
    if (!normalizedConfig.days.includes(weekday)) return [];
    const candidates: { examiner: RotationExaminerLike; time: string }[] = [];
    for (const ex of baseEligibility.eligible) {
      const times = getExaminerRotationTimesForDate(ex, date, normalizedConfig);
      for (const time of times) {
        if (!isExaminerBlockedOnDateTime(ex.blockedPeriods, date, time).blocked) {
          candidates.push({ examiner: ex, time });
        }
      }
    }
    return candidates;
  };

  const isAutoEntryStillValid = (entry: RotationScheduleEntry): boolean => {
    if (!isCalendarDate(entry.date) || entry.date < today || entry.date > maxDate) return false;
    if (suppressedSet.has(entry.date) || pausedSet.has(entry.date)) return false;
    const weekday = scaleWeekday(entry.date);
    if (!normalizedConfig.days.includes(weekday)) return false;
    if (isSystemDateBlockedForRotation(entry.date, blockedDates, input.systemSettings).blocked) return false;
    if (!cityId) return false;
    const ex = examinerMap.get(entry.examiner);
    if (!ex || !ex.examRotation || ex.canExamCommon === false) return false;
    const av = ex.rotationAvailability;
    if (!av || !av.cityIds?.includes(cityId)) return false;
    const validTimes = getExaminerRotationTimesForDate(ex, entry.date, normalizedConfig);
    const normalizedTime = normalizeScaleTime(entry.time);
    if (!validTimes.includes(normalizedTime)) return false;
    if (isExaminerBlockedOnDateTime(ex.blockedPeriods, entry.date, normalizedTime).blocked) return false;
    return true;
  };

  const rawExisting = Array.isArray(input.existingEntries) ? input.existingEntries : [];
  const keptEntries: RotationScheduleEntry[] = [];
  const candidateAutoEntries: RotationScheduleEntry[] = [];

  for (const item of rawExisting) {
    if (!item || !isCalendarDate(item.date) || item.date < today) continue;
    if (item.manual) {
      keptEntries.push({
        id: item.id || createId(),
        date: item.date,
        time: normalizeScaleTime(item.time),
        examiner: item.examiner,
        manual: true,
      });
      continue;
    }
    if (!input.forceRebalanceAuto && isAutoEntryStillValid(item)) {
      candidateAutoEntries.push({
        id: item.id || createId(),
        date: item.date,
        time: normalizeScaleTime(item.time),
        examiner: item.examiner,
        manual: false,
      });
    }
  }

  // Rastreia compromissos manuais já fixados nesta escola para evitar conflitos na mesma semana/dia
  const manualWeekCounts = new Map<string, number>();
  for (const m of keptEntries) {
    const wk = getRotationWeekKey(m.date);
    if (wk && m.examiner) {
      manualWeekCounts.set(`${wk}|${m.examiner}`, (manualWeekCounts.get(`${wk}|${m.examiner}`) ?? 0) + 1);
    }
  }

  for (const autoEntry of candidateAutoEntries) {
    if (hasOtherSchools) {
      const weekKey = getRotationWeekKey(autoEntry.date);
      const weekExKey = `${weekKey}|${autoEntry.examiner}`;
      const dateExKey = `${autoEntry.date}|${autoEntry.examiner}`;
      const dtExKey = `${autoEntry.date}|${autoEntry.time}|${autoEntry.examiner}`;
      const ex = examinerMap.get(autoEntry.examiner);
      const maxPerDay = getExaminerMaxPerDayForDate(ex, autoEntry.date);

      const hasExactDateTimeClash = (crossIndex.dateTimeCounts.get(dtExKey) ?? 0) > 0;
      const exceedsOtherDay = (crossIndex.dateCounts.get(dateExKey) ?? 0) >= maxPerDay;
      const otherWeekPresence = crossIndex.weekSchoolSets.get(weekExKey)?.size ?? 0;

      if (hasExactDateTimeClash || exceedsOtherDay || otherWeekPresence > 0) {
        const alternatives = listCandidatesForDate(autoEntry.date);
        const hasStrictlyBetterAlternative = alternatives.some(cand => {
          if (cand.examiner.id === autoEntry.examiner && cand.time === autoEntry.time) return false;
          const cWeekKey = `${weekKey}|${cand.examiner.id}`;
          const cDateKey = `${autoEntry.date}|${cand.examiner.id}`;
          const cDtKey = `${autoEntry.date}|${cand.time}|${cand.examiner.id}`;
          const cMaxDay = getExaminerMaxPerDayForDate(cand.examiner, autoEntry.date);
          const cDtClash = (crossIndex.dateTimeCounts.get(cDtKey) ?? 0) > 0;
          const cDayCount = crossIndex.dateCounts.get(cDateKey) ?? 0;
          const cWeekPresence = crossIndex.weekSchoolSets.get(cWeekKey)?.size ?? 0;

          if (cDtClash || cDayCount >= cMaxDay) return false;
          if (hasExactDateTimeClash || exceedsOtherDay) return true;
          const cManualWeek = manualWeekCounts.get(cWeekKey) ?? 0;
          return cWeekPresence < otherWeekPresence && cManualWeek === 0;
        });

        if (hasStrictlyBetterAlternative) {
          // Descarta entrada automática antiga para que o gerador selecione examinador sem repetir na semana
          continue;
        }
      }
    }
    keptEntries.push(autoEntry);
  }

  const coveredDates = new Set(keptEntries.map(e => e.date));
  const counts = new Map<string, number>();
  const lastDate = new Map<string, string>();
  const thisWeekCounts = new Map<string, number>();
  const thisDateCounts = new Map<string, number>();
  const thisDateTimeCounts = new Map<string, number>();

  for (const ex of input.examiners) {
    counts.set(ex.id, 0);
  }
  for (const entry of keptEntries) {
    if (entry.date <= maxDate && entry.examiner) {
      counts.set(entry.examiner, (counts.get(entry.examiner) ?? 0) + 1);
      const prev = lastDate.get(entry.examiner) ?? '';
      if (entry.date > prev) lastDate.set(entry.examiner, entry.date);
      const wk = getRotationWeekKey(entry.date);
      if (wk) {
        thisWeekCounts.set(`${wk}|${entry.examiner}`, (thisWeekCounts.get(`${wk}|${entry.examiner}`) ?? 0) + 1);
      }
      thisDateCounts.set(`${entry.date}|${entry.examiner}`, (thisDateCounts.get(`${entry.date}|${entry.examiner}`) ?? 0) + 1);
      const t = normalizeScaleTime(entry.time);
      if (isValidScaleTime(t)) {
        thisDateTimeCounts.set(`${entry.date}|${t}|${entry.examiner}`, (thisDateTimeCounts.get(`${entry.date}|${t}|${entry.examiner}`) ?? 0) + 1);
      }
    }
  }

  const warnings: string[] = [];
  if (baseEligibility.issue) {
    warnings.push(baseEligibility.issue);
  }
  const seenCrossRepeatWarnings = new Set<string>();

  const generatedEntries: RotationScheduleEntry[] = [];
  const dates = listForwardDates(today, horizonDays);

  for (const date of dates) {
    if (coveredDates.has(date) || suppressedSet.has(date) || pausedSet.has(date)) continue;
    const weekday = scaleWeekday(date);
    if (!normalizedConfig.days.includes(weekday)) continue;
    if (isSystemDateBlockedForRotation(date, blockedDates, input.systemSettings).blocked) continue;
    if (!cityId) continue;

    const candidates = listCandidatesForDate(date);
    if (candidates.length === 0) {
      if (baseEligibility.eligible.length > 0) {
        warnings.push(`Sem examinador disponível em ${formatRotationDateBR(date)} (${weekday}) — verifique afastamentos/férias ou horários.`);
      }
      continue;
    }

    const weekKey = getRotationWeekKey(date);
    const scored = candidates.map(cand => ({
      ...cand,
      score: scoreRotationCandidate({
        examiner: cand.examiner,
        date,
        time: cand.time,
        weekKey,
        crossIndex,
        schoolCounts: counts,
        thisWeekCounts,
        thisDateCounts,
        thisDateTimeCounts,
      }),
    }));

    scored.sort((a, b) => {
      const scoreDiff = compareCandidateScores(a.score, b.score);
      if (scoreDiff !== 0) return scoreDiff;
      const lastDiff = (lastDate.get(a.examiner.id) ?? '').localeCompare(lastDate.get(b.examiner.id) ?? '');
      if (lastDiff !== 0) return lastDiff;
      const nameDiff = a.examiner.name.localeCompare(b.examiner.name);
      if (nameDiff !== 0) return nameDiff;
      const timeDiff = a.time.localeCompare(b.time);
      if (timeDiff !== 0) return timeDiff;
      return a.examiner.id.localeCompare(b.examiner.id);
    });

    const chosen = scored[0];
    generatedEntries.push({
      id: createId(),
      date,
      time: chosen.time,
      examiner: chosen.examiner.id,
      manual: false,
    });
    coveredDates.add(date);
    counts.set(chosen.examiner.id, (counts.get(chosen.examiner.id) ?? 0) + 1);
    lastDate.set(chosen.examiner.id, date);
    if (weekKey) {
      const wkExKey = `${weekKey}|${chosen.examiner.id}`;
      thisWeekCounts.set(wkExKey, (thisWeekCounts.get(wkExKey) ?? 0) + 1);
      if (chosen.score.otherWeekPresence > 0 && !seenCrossRepeatWarnings.has(wkExKey)) {
        seenCrossRepeatWarnings.add(wkExKey);
        const otherNames = [...(crossIndex.weekSchoolNames.get(wkExKey)?.values() ?? [])];
        warnings.push(
          `Semana de ${formatRotationDateBR(weekKey)}: ${chosen.examiner.name} também está escalado(a) em ${otherNames.join(', ')} (sem outro examinador livre nessa semana).`,
        );
      }
    }
    thisDateCounts.set(`${date}|${chosen.examiner.id}`, (thisDateCounts.get(`${date}|${chosen.examiner.id}`) ?? 0) + 1);
    thisDateTimeCounts.set(`${date}|${chosen.time}|${chosen.examiner.id}`, (thisDateTimeCounts.get(`${date}|${chosen.time}|${chosen.examiner.id}`) ?? 0) + 1);
  }

  const finalEntries = [...keptEntries, ...generatedEntries].sort(
    (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time),
  );

  const summaryIds = new Set<string>([
    ...baseEligibility.eligible.map(e => e.id),
    ...finalEntries.map(e => e.examiner).filter(Boolean),
  ]);
  const distribution = [...summaryIds]
    .map(examinerId => ({
      examinerId,
      examinerName: examinerMap.get(examinerId)?.name ?? examinerId,
      count: finalEntries.filter(e => e.examiner === examinerId).length,
    }))
    .sort((a, b) => a.examinerName.localeCompare(b.examinerName));

  const serializeEntries = (list: RotationScheduleEntry[]) =>
    list
      .map(e => `${e.date}|${normalizeScaleTime(e.time)}|${e.examiner}|${e.manual ? '1' : '0'}`)
      .join(';');
  const changed =
    serializeEntries(rawExisting) !== serializeEntries(finalEntries) ||
    rawSuppressed.join(',') !== cleanedSuppressed.join(',');

  return {
    entries: finalEntries,
    suppressedDates: cleanedSuppressed,
    warnings,
    distribution,
    changed,
  };
}

export function filterUpcomingRotationNext7Days(
  entries: RotationScheduleEntry[] | null | undefined,
  today = businessDate(),
  daysAhead = 7,
): RotationScheduleEntry[] {
  if (!Array.isArray(entries) || !isCalendarDate(today)) return [];
  const maxDate = addCalendarDays(today, Math.max(0, daysAhead));
  return entries
    .filter(entry => !!entry && isCalendarDate(entry.date) && entry.date >= today && entry.date <= maxDate)
    .sort((a, b) => a.date.localeCompare(b.date) || normalizeScaleTime(a.time).localeCompare(normalizeScaleTime(b.time)));
}

export interface ShuffleRotationScheduleInput extends Omit<SyncRotationScheduleInput, 'forceRebalanceAuto'> {
  rng?: () => number;
}

function fisherYatesShuffle<T>(items: T[], rng: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function shuffleRotationSchedule(input: ShuffleRotationScheduleInput): SyncRotationScheduleResult {
  const today = input.today ?? businessDate();
  const horizonDays = input.horizonDays ?? 30;
  const maxDate = addCalendarDays(today, horizonDays);
  const blockedDates = input.blockedDates ?? [];
  const pausedSet = new Set((input.pausedDates ?? []).filter(isCalendarDate));
  const createId = input.createId ?? (() => crypto.randomUUID());
  const rng = input.rng ?? Math.random;
  const maxAttempts = input.rng ? 1 : 10;

  const normalizedConfig: RotationConfig = {
    days: Array.from(new Set(input.config.days ?? [])),
    startTime: normalizeScaleTime(input.config.startTime),
    endTime: normalizeScaleTime(input.config.endTime),
  };

  const rawSuppressed = Array.isArray(input.suppressedDates) ? input.suppressedDates : [];
  const cleanedSuppressed = Array.from(
    new Set(rawSuppressed.filter(d => isCalendarDate(d) && d >= today && d <= maxDate)),
  ).sort();
  const suppressedSet = new Set(cleanedSuppressed);

  const cityId = resolveCityIdByName(input.schoolCity, input.cities);
  const examinerMap = new Map(input.examiners.map(ex => [ex.id, ex]));
  const crossIndex = buildCrossSchoolUsageIndex(input.otherSchools, input.currentSchoolId, today);

  const rawExisting = Array.isArray(input.existingEntries) ? input.existingEntries : [];
  const manualEntries: RotationScheduleEntry[] = [];
  for (const item of rawExisting) {
    if (!item || !isCalendarDate(item.date) || item.date < today) continue;
    if (item.manual) {
      manualEntries.push({
        id: item.id || createId(),
        date: item.date,
        time: normalizeScaleTime(item.time),
        examiner: item.examiner,
        manual: true,
      });
    }
  }

  const coveredDates = new Set(manualEntries.map(e => e.date));
  const baseEligibility = findEligibleExaminersForSchool({
    schoolCity: input.schoolCity,
    config: normalizedConfig,
    examiners: input.examiners,
    cities: input.cities,
    today,
  });

  const baseWarnings: string[] = [];
  if (baseEligibility.issue) {
    baseWarnings.push(baseEligibility.issue);
  }

  const dateSlots: { date: string; candidates: { examiner: RotationExaminerLike; time: string }[]; distinctExaminerCount: number }[] = [];
  for (const date of listForwardDates(today, horizonDays)) {
    if (coveredDates.has(date) || suppressedSet.has(date) || pausedSet.has(date)) continue;
    const weekday = scaleWeekday(date);
    if (!normalizedConfig.days.includes(weekday)) continue;
    if (isSystemDateBlockedForRotation(date, blockedDates, input.systemSettings).blocked) continue;
    if (!cityId) continue;

    const candidates: { examiner: RotationExaminerLike; time: string }[] = [];
    for (const ex of baseEligibility.eligible) {
      const times = getExaminerRotationTimesForDate(ex, date, normalizedConfig);
      for (const time of times) {
        if (!isExaminerBlockedOnDateTime(ex.blockedPeriods, date, time).blocked) {
          candidates.push({ examiner: ex, time });
        }
      }
    }

    if (candidates.length === 0) {
      if (baseEligibility.eligible.length > 0) {
        baseWarnings.push(`Sem examinador disponível em ${formatRotationDateBR(date)} (${weekday}) — verifique afastamentos/férias ou horários.`);
      }
      continue;
    }

    const distinctExaminerCount = new Set(candidates.map(c => c.examiner.id)).size;
    dateSlots.push({ date, candidates, distinctExaminerCount });
  }

  const serializeEntries = (list: RotationScheduleEntry[]) =>
    list
      .map(e => `${e.date}|${normalizeScaleTime(e.time)}|${e.examiner}|${e.manual ? '1' : '0'}`)
      .join(';');

  const previousSignature = serializeEntries(
    rawExisting
      .filter(e => e && isCalendarDate(e.date) && e.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date) || normalizeScaleTime(a.time).localeCompare(normalizeScaleTime(b.time))),
  );

  let chosenEntries: RotationScheduleEntry[] = [];
  let chosenWarnings: string[] = [...baseWarnings];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const counts = new Map<string, number>();
    const thisWeekCounts = new Map<string, number>();
    const thisDateCounts = new Map<string, number>();
    const thisDateTimeCounts = new Map<string, number>();

    for (const ex of input.examiners) {
      counts.set(ex.id, 0);
    }
    for (const entry of manualEntries) {
      if (entry.date <= maxDate && entry.examiner) {
        counts.set(entry.examiner, (counts.get(entry.examiner) ?? 0) + 1);
        const wk = getRotationWeekKey(entry.date);
        if (wk) {
          thisWeekCounts.set(`${wk}|${entry.examiner}`, (thisWeekCounts.get(`${wk}|${entry.examiner}`) ?? 0) + 1);
        }
        thisDateCounts.set(`${entry.date}|${entry.examiner}`, (thisDateCounts.get(`${entry.date}|${entry.examiner}`) ?? 0) + 1);
        const t = normalizeScaleTime(entry.time);
        if (isValidScaleTime(t)) {
          thisDateTimeCounts.set(`${entry.date}|${t}|${entry.examiner}`, (thisDateTimeCounts.get(`${entry.date}|${t}|${entry.examiner}`) ?? 0) + 1);
        }
      }
    }

    // Agrupa datas por nível de restrição (datas com menos examinadores primeiro) e embaralha dentro de cada grupo.
    const byConstraint = new Map<number, typeof dateSlots>();
    for (const slot of dateSlots) {
      const bucket = byConstraint.get(slot.distinctExaminerCount) ?? [];
      bucket.push(slot);
      byConstraint.set(slot.distinctExaminerCount, bucket);
    }
    const orderedSlots = [...byConstraint.keys()]
      .sort((a, b) => a - b)
      .flatMap(level => fisherYatesShuffle(byConstraint.get(level)!, rng));

    const generated: RotationScheduleEntry[] = [];
    const attemptWarnings = [...baseWarnings];
    const seenCrossWarnings = new Set<string>();

    for (const slot of orderedSlots) {
      const weekKey = getRotationWeekKey(slot.date);
      const scored = slot.candidates.map(cand => ({
        ...cand,
        score: scoreRotationCandidate({
          examiner: cand.examiner,
          date: slot.date,
          time: cand.time,
          weekKey,
          crossIndex,
          schoolCounts: counts,
          thisWeekCounts,
          thisDateCounts,
          thisDateTimeCounts,
        }),
      }));

      scored.sort((a, b) => compareCandidateScores(a.score, b.score));
      const bestScore = scored[0].score;
      const tied = scored.filter(c => compareCandidateScores(c.score, bestScore) === 0);
      const chosen = tied[Math.floor(rng() * tied.length)];

      generated.push({
        id: createId(),
        date: slot.date,
        time: chosen.time,
        examiner: chosen.examiner.id,
        manual: false,
      });
      counts.set(chosen.examiner.id, (counts.get(chosen.examiner.id) ?? 0) + 1);
      if (weekKey) {
        const wkExKey = `${weekKey}|${chosen.examiner.id}`;
        thisWeekCounts.set(wkExKey, (thisWeekCounts.get(wkExKey) ?? 0) + 1);
        if (chosen.score.otherWeekPresence > 0 && !seenCrossWarnings.has(wkExKey)) {
          seenCrossWarnings.add(wkExKey);
          const otherNames = [...(crossIndex.weekSchoolNames.get(wkExKey)?.values() ?? [])];
          attemptWarnings.push(
            `Semana de ${formatRotationDateBR(weekKey)}: ${chosen.examiner.name} também está escalado(a) em ${otherNames.join(', ')} (sem outro examinador livre nessa semana).`,
          );
        }
      }
      thisDateCounts.set(`${slot.date}|${chosen.examiner.id}`, (thisDateCounts.get(`${slot.date}|${chosen.examiner.id}`) ?? 0) + 1);
      thisDateTimeCounts.set(`${slot.date}|${chosen.time}|${chosen.examiner.id}`, (thisDateTimeCounts.get(`${slot.date}|${chosen.time}|${chosen.examiner.id}`) ?? 0) + 1);
    }

    const candidateFinal = [...manualEntries, ...generated].sort(
      (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time),
    );
    chosenEntries = candidateFinal;
    chosenWarnings = attemptWarnings;
    if (serializeEntries(candidateFinal) !== previousSignature) {
      break;
    }
  }

  const summaryIds = new Set<string>([
    ...baseEligibility.eligible.map(e => e.id),
    ...chosenEntries.map(e => e.examiner).filter(Boolean),
  ]);
  const distribution = [...summaryIds]
    .map(examinerId => ({
      examinerId,
      examinerName: examinerMap.get(examinerId)?.name ?? examinerId,
      count: chosenEntries.filter(e => e.examiner === examinerId).length,
    }))
    .sort((a, b) => a.examinerName.localeCompare(b.examinerName));

  const changed =
    serializeEntries(rawExisting) !== serializeEntries(chosenEntries) ||
    rawSuppressed.join(',') !== cleanedSuppressed.join(',');

  return {
    entries: chosenEntries,
    suppressedDates: cleanedSuppressed,
    warnings: chosenWarnings,
    distribution,
    changed,
  };
}

export interface SyncAllSchoolsRotationInput<TSchool extends OtherSchoolRotationLike> {
  schools: TSchool[];
  examiners: RotationExaminerLike[];
  cities: RotationCityLike[];
  blockedDates?: RotationBlockedDateLike[];
  systemSettings?: RotationSystemSettingsLike | null;
  today?: string;
  horizonDays?: number;
  forceRebalanceAuto?: boolean;
  createId?: () => string;
}

export interface SyncAllSchoolsRotationResult<TSchool extends OtherSchoolRotationLike> {
  schools: TSchool[];
  updates: {
    id: string;
    mainSchedule: NonNullable<TSchool['mainSchedule']>;
    warnings: string[];
  }[];
}

export function syncAllSchoolsRotationSchedules<TSchool extends OtherSchoolRotationLike>(
  input: SyncAllSchoolsRotationInput<TSchool>,
): SyncAllSchoolsRotationResult<TSchool> {
  const today = input.today ?? businessDate();
  const workingSchools: TSchool[] = input.schools.map(s => ({ ...s }));
  const indexById = new Map(workingSchools.map((s, idx) => [s.id, idx]));

  const eligibleOrder = workingSchools
    .filter(isActiveRotationSchool)
    .map(s => {
      const config = s.mainSchedule!.rotationConfig!;
      const eligibleCount = findEligibleExaminersForSchool({
        schoolCity: s.city,
        config,
        examiners: input.examiners,
        cities: input.cities,
        today,
      }).eligible.length;
      const validFutureCount = (s.mainSchedule?.rotationEntries ?? []).filter(
        e => e && isCalendarDate(e.date) && e.date >= today,
      ).length;
      return { id: s.id, name: s.name || '', eligibleCount, validFutureCount };
    })
    .sort(
      (a, b) =>
        a.eligibleCount - b.eligibleCount ||
        b.validFutureCount - a.validFutureCount ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );

  const latestUpdateById = new Map<string, SyncAllSchoolsRotationResult<TSchool>['updates'][number]>();
  const initialMainById = new Map(input.schools.map(s => [s.id, s.mainSchedule]));

  for (let pass = 0; pass < 2; pass++) {
    let passChanged = false;
    for (const item of eligibleOrder) {
      const idx = indexById.get(item.id);
      if (idx === undefined) continue;
      const school = workingSchools[idx];
      const main = school.mainSchedule!;
      const synced = syncRollingRotationSchedule({
        currentSchoolId: school.id,
        schoolCity: school.city,
        config: main.rotationConfig!,
        existingEntries: main.rotationEntries ?? [],
        suppressedDates: main.suppressedRotationDates ?? [],
        pausedDates: main.pausedDates ?? [],
        otherSchools: workingSchools,
        examiners: input.examiners,
        cities: input.cities,
        blockedDates: input.blockedDates,
        systemSettings: input.systemSettings,
        today,
        horizonDays: input.horizonDays,
        forceRebalanceAuto: pass === 0 ? input.forceRebalanceAuto : false,
        createId: input.createId,
      });

      if (synced.changed) {
        passChanged = true;
        const updatedMain = {
          ...main,
          rotationEntries: synced.entries,
          suppressedRotationDates: synced.suppressedDates,
        } as NonNullable<TSchool['mainSchedule']>;

        workingSchools[idx] = {
          ...school,
          mainSchedule: updatedMain,
        };
        latestUpdateById.set(school.id, {
          id: school.id,
          mainSchedule: updatedMain,
          warnings: synced.warnings,
        });
      } else if (latestUpdateById.has(school.id)) {
        latestUpdateById.set(school.id, {
          id: school.id,
          mainSchedule: main as NonNullable<TSchool['mainSchedule']>,
          warnings: synced.warnings,
        });
      }
    }
    if (!passChanged) break;
  }

  const updates = [...latestUpdateById.values()].filter(u => {
    const initial = initialMainById.get(u.id);
    return JSON.stringify(initial?.rotationEntries ?? []) !== JSON.stringify(u.mainSchedule.rotationEntries ?? []) ||
      JSON.stringify(initial?.suppressedRotationDates ?? []) !== JSON.stringify(u.mainSchedule.suppressedRotationDates ?? []);
  });

  return { schools: workingSchools, updates };
}

export interface ExaminerScheduleSlotLike {
  id?: string;
  schoolId?: string | null;
  examinerId?: string | null;
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  requestType?: string | null;
  status?: string | null;
}

export interface ExaminerExamRequestLike {
  id?: string;
  schoolId?: string | null;
  examinerId?: string | null;
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  requestType?: string | null;
  status?: string | null;
  examType?: string | null;
  modulo?: string | null;
}

export interface ExaminerCnhScheduleLike {
  id?: string;
  date?: string | null;
  time?: string | null;
  examinerIds?: string[] | null;
  type?: string | null;
  status?: string | null;
  locationId?: string | null;
}

export interface ExaminerUpcomingScheduleItem {
  id: string;
  date: string;
  time: string;
  schoolId: string;
  schoolName: string;
  source: 'ROTATION' | 'PROVISIONAL' | 'WEEKLY' | 'CONFIRMED_SLOT' | 'CNH_BANCA';
}

export interface BuildExaminerUpcomingSchedulesInput {
  examiner: {
    id: string;
    name?: string | null;
    examRotation?: boolean;
    blockedPeriods?: RotationBlockedPeriodLike[] | null;
  } | null | undefined;
  schools: OtherSchoolRotationLike[];
  scheduleSlots?: ExaminerScheduleSlotLike[] | null;
  requests?: ExaminerExamRequestLike[] | null;
  cnhSchedules?: ExaminerCnhScheduleLike[] | null;
  blockedDates?: RotationBlockedDateLike[] | null;
  systemSettings?: (RotationSystemSettingsLike & { pcdExamName?: string | null }) | null;
  today?: string;
  horizonDays?: number;
}

export function buildExaminerUpcomingSchedules(
  input: BuildExaminerUpcomingSchedulesInput,
): ExaminerUpcomingScheduleItem[] {
  const examiner = input.examiner;
  if (!examiner?.id) return [];

  const today = input.today && isCalendarDate(input.today) ? input.today : businessDate();
  const horizonDays = Math.max(0, input.horizonDays ?? 30);
  const maxDate = addCalendarDays(today, horizonDays);
  const blockedDates = input.blockedDates ?? [];
  const examinerNameUpper = String(examiner.name ?? '').trim().toUpperCase();

  const matchesExaminer = (idOrName?: string | null): boolean => {
    const raw = String(idOrName ?? '').trim();
    if (!raw) return false;
    if (raw === examiner.id) return true;
    return examinerNameUpper !== '' && raw.toUpperCase() === examinerNameUpper;
  };

  const schoolMap = new Map<string, OtherSchoolRotationLike>();
  const bancaLinkByScheduleId = new Map<
    string,
    { schoolId: string; schoolName: string; entryId?: string; date: string; time: string }
  >();
  for (const s of input.schools ?? []) {
    if (!s?.id) continue;
    schoolMap.set(s.id, s);
    const links = Array.isArray(s.mainSchedule?.autoCnhBancaLinks) ? s.mainSchedule.autoCnhBancaLinks : [];
    for (const link of links) {
      if (!link?.scheduleId) continue;
      bancaLinkByScheduleId.set(link.scheduleId, {
        schoolId: s.id,
        schoolName: s.name || s.id,
        entryId: link.entryId,
        date: String(link.date ?? '').split('T')[0],
        time: normalizeScaleTime(link.time),
      });
    }
  }

  const cnhSchedules = Array.isArray(input.cnhSchedules) ? input.cnhSchedules : [];
  const cnhScheduleIds = new Set(cnhSchedules.map(s => s?.id).filter((id): id is string => Boolean(id)));
  const overriddenRotationEntryIds = new Set<string>();
  const overriddenRotationKeys = new Set<string>();
  for (const [scheduleId, link] of bancaLinkByScheduleId.entries()) {
    if (!cnhScheduleIds.has(scheduleId)) continue;
    if (link.entryId) overriddenRotationEntryIds.add(link.entryId);
    if (isCalendarDate(link.date)) {
      overriddenRotationKeys.add(`${link.schoolId}|${link.date}|${link.time}`);
    }
  }

  const resolveSchoolDisplayName = (schoolId: string): string => {
    if (schoolId === 'PCD') return input.systemSettings?.pcdExamName || 'PROVA DIRECAO PCD';
    if (schoolId === 'CNH_BRASIL') return 'CNH DO BRASIL';
    return schoolMap.get(schoolId)?.name || schoolId;
  };

  const byKey = new Map<string, ExaminerUpcomingScheduleItem>();
  const generatedFixedKeys = new Set<string>();
  const activeFixedDatesBySchool = new Map<string, Set<string>>();

  const appointmentSources: (ExaminerScheduleSlotLike | ExaminerExamRequestLike)[] = [
    ...(input.scheduleSlots ?? []),
    ...(input.requests ?? []),
  ];

  for (const item of appointmentSources) {
    if (!item) continue;
    const date = String(item.scheduledDate ?? '').split('T')[0].trim();
    if (!isCalendarDate(date)) continue;
    const schoolId = String(item.schoolId ?? '').trim();
    if (!schoolId || schoolId === 'CNH_BRASIL') continue;
    if (item.status === 'WAITING_SCHEDULING') continue;
    if (item.requestType === 'FIXA' && item.status !== 'CANCELLED') {
      let schoolFixedDates = activeFixedDatesBySchool.get(schoolId);
      if (!schoolFixedDates) {
        schoolFixedDates = new Set<string>();
        activeFixedDatesBySchool.set(schoolId, schoolFixedDates);
      }
      schoolFixedDates.add(date);
    }
    if (date < today || date > maxDate) continue;
    if (item.requestType === 'FIXA') {
      generatedFixedKeys.add(`${schoolId}|${date}`);
    }
    if (item.status === 'CANCELLED') continue;
    if (!matchesExaminer(item.examinerId)) continue;
    const time = normalizeScaleTime(item.scheduledTime);
    const schoolName = resolveSchoolDisplayName(schoolId);
    const key = `${date}|${time}|${schoolId}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        id: item.id || `slot:${key}`,
        date,
        time,
        schoolId,
        schoolName,
        source: 'CONFIRMED_SLOT',
      });
    }
  }

  const biweeklyAnchorBySchool = new Map<string, string>();
  const futureFixedDatesBySchool = new Map<string, string[]>();
  for (const [schoolId, dateSet] of activeFixedDatesBySchool.entries()) {
    const sorted = [...dateSet].sort();
    const pastDates = sorted.filter(d => d < today);
    if (pastDates.length > 0) {
      biweeklyAnchorBySchool.set(schoolId, pastDates[pastDates.length - 1]);
    }
    futureFixedDatesBySchool.set(schoolId, sorted.filter(d => d >= today));
  }

  for (const sched of cnhSchedules) {
    if (!sched || sched.status === 'CANCELLED') continue;
    const date = String(sched.date ?? '').split('T')[0].trim();
    if (!isCalendarDate(date) || date < today || date > maxDate) continue;
    const examinersInBanca = Array.isArray(sched.examinerIds) ? sched.examinerIds : [];
    if (!examinersInBanca.some(matchesExaminer)) continue;
    const linked = sched.id ? bancaLinkByScheduleId.get(sched.id) : undefined;
    const schoolId = linked?.schoolId || 'CNH_BRASIL';
    const schoolName = linked?.schoolName || 'CNH DO BRASIL';
    const time = normalizeScaleTime(sched.time);
    const key = `${date}|${time}|${schoolId}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        id: sched.id ? `banca:${sched.id}` : `banca:${key}`,
        date,
        time,
        schoolId,
        schoolName,
        source: 'CNH_BANCA',
      });
    }
  }

  for (const date of listForwardDates(today, horizonDays)) {
    const systemBlocked = isSystemDateBlockedForRotation(date, blockedDates, input.systemSettings).blocked;
    for (const school of input.schools ?? []) {
      if (!school?.id || school.id === 'PCD' || school.id === 'CNH_BRASIL') continue;
      if (activeFixedDatesBySchool.get(school.id)?.has(date)) {
        biweeklyAnchorBySchool.set(school.id, date);
      }
      if (generatedFixedKeys.has(`${school.id}|${date}`)) continue;

      const resolved = resolveSchoolScaleForDate(
        {
          examRotation: Boolean(school.examRotation),
          mainSchedule: school.mainSchedule as any,
          provisionalSchedule: school.provisionalSchedule as any,
        },
        date,
      );

      if (resolved.kind === 'ROTATION_DATES') {
        const rawEntries = Array.isArray(school.mainSchedule?.rotationEntries)
          ? school.mainSchedule!.rotationEntries
          : [];
        for (const entry of resolved.entries) {
          if (!matchesExaminer(entry.examiner)) continue;
          const time = normalizeScaleTime(entry.time);
          const rawEntry = rawEntries.find(
            r =>
              r &&
              r.date === date &&
              normalizeScaleTime(r.time) === time &&
              matchesExaminer(r.examiner),
          );
          if (rawEntry?.id && overriddenRotationEntryIds.has(rawEntry.id)) continue;
          if (overriddenRotationKeys.has(`${school.id}|${date}|${time}`)) continue;
          if (!rawEntry?.manual) {
            if (examiner.examRotation === false) continue;
            if (systemBlocked) continue;
            if (isExaminerBlockedOnDateTime(examiner.blockedPeriods, date, time).blocked) continue;
          }
          const key = `${date}|${time}|${school.id}`;
          if (!byKey.has(key)) {
            byKey.set(key, {
              id: `rot:${key}`,
              date,
              time,
              schoolId: school.id,
              schoolName: school.name || school.id,
              source: 'ROTATION',
            });
          }
        }
      } else if (resolved.kind === 'PROVISIONAL_DATES') {
        for (const entry of resolved.specificDates) {
          if (!matchesExaminer(entry.examiner)) continue;
          const time = normalizeScaleTime(entry.time);
          const key = `${date}|${time}|${school.id}`;
          if (!byKey.has(key)) {
            byKey.set(key, {
              id: `prov:${key}`,
              date,
              time,
              schoolId: school.id,
              schoolName: school.name || school.id,
              source: 'PROVISIONAL',
            });
          }
        }
      } else if (resolved.kind === 'WEEKLY_SLOTS' && !school.examRotation) {
        if (systemBlocked) continue;
        if (resolved.schedule.frequency === '15_DAYS') {
          if (resolved.slots.length === 0) continue;
          const lastAnchor = biweeklyAnchorBySchool.get(school.id);
          if (lastAnchor && diffCalendarDays(lastAnchor, date) < 14) continue;
          const futureFixedDates = futureFixedDatesBySchool.get(school.id) ?? [];
          if (futureFixedDates.some(fd => fd > date && diffCalendarDays(date, fd) < 14)) continue;
          biweeklyAnchorBySchool.set(school.id, date);
        }
        for (const slot of resolved.slots) {
          if (!matchesExaminer(slot.examiner)) continue;
          const time = normalizeScaleTime(slot.time);
          if (isExaminerBlockedOnDateTime(examiner.blockedPeriods, date, time).blocked) continue;
          const key = `${date}|${time}|${school.id}`;
          if (!byKey.has(key)) {
            byKey.set(key, {
              id: `weekly:${key}`,
              date,
              time,
              schoolId: school.id,
              schoolName: school.name || school.id,
              source: 'WEEKLY',
            });
          }
        }
      }
    }
  }

  return [...byKey.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.time.localeCompare(b.time) ||
      a.schoolName.localeCompare(b.schoolName),
  );
}

export function formatExaminerUpcomingSchedulesWhatsApp(input: {
  examinerName?: string | null;
  items: Pick<ExaminerUpcomingScheduleItem, 'date' | 'time' | 'schoolName'>[];
}): string {
  const lines: string[] = [];
  lines.push('*Escala Prova Prática dos próximos 30 dias*');
  const examinerName = String(input.examinerName ?? '').trim();
  if (examinerName) {
    lines.push('');
    lines.push(`Examinador: *${examinerName}*`);
  }
  lines.push('');

  if (!Array.isArray(input.items) || input.items.length === 0) {
    lines.push('Nenhuma escala encontrada nos próximos 30 dias.');
  } else {
    input.items.forEach((item, index) => {
      if (index > 0) lines.push('');
      const dateBr = formatRotationDateBR(item.date);
      const weekday = scaleWeekday(item.date);
      const time = item.time || '—';
      lines.push(`• *${dateBr}${weekday ? ` (${weekday})` : ''}* - ${time} - ${item.schoolName}`);
    });
  }

  lines.push('');
  lines.push('⚠️ Atenção: Se houver necessidade de alterar os dias ou horários, ou de cancelar alguma prova, solicitamos que nos informe com antecedência.');
  return lines.join('\n');
}


