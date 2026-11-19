import {
  businessDate,
  isCalendarDate,
  isValidScaleTime,
  normalizeScaleTime,
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
  canExamCommon?: boolean;
  examRotation?: boolean;
  rotationAvailability?: {
    days: string[];
    defaultTime: string;
    secondDefaultTime?: string;
    examsPerDay: 1 | 2;
    cityIds: string[];
  } | null;
  blockedPeriods?: RotationBlockedPeriodLike[];
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

export function getExaminerRotationTimesInWindow(
  examiner: RotationExaminerLike,
  config: RotationConfig,
): string[] {
  const av = examiner.rotationAvailability;
  if (!av) return [];
  const rawTimes = av.examsPerDay === 2
    ? [av.defaultTime, av.secondDefaultTime ?? '']
    : [av.defaultTime];
  const unique = new Set<string>();
  for (const raw of rawTimes) {
    const t = normalizeScaleTime(raw);
    if (isValidScaleTime(t) && isTimeWithinWindow(t, config.startTime, config.endTime)) {
      unique.add(t);
    }
  }
  return [...unique];
}

export function findEligibleExaminersForSchool(input: {
  schoolCity?: string | null;
  config: RotationConfig;
  examiners: RotationExaminerLike[];
  cities: RotationCityLike[];
}): {
  cityId: string | null;
  eligible: RotationExaminerLike[];
  issue?: string;
} {
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
    if (!Array.isArray(av.days) || !av.days.some(d => configDays.has(d))) return false;
    return getExaminerRotationTimesInWindow(ex, input.config).length > 0;
  });
  if (eligible.length === 0) {
    return {
      cityId,
      eligible: [],
      issue: 'Nenhum examinador elegível com "Participar do Rodízio de Provas", cidade, dia e horário compatíveis.',
    };
  }
  return { cityId, eligible };
}

export interface SyncRotationScheduleInput {
  schoolCity?: string | null;
  config: RotationConfig;
  existingEntries?: RotationScheduleEntry[] | null;
  suppressedDates?: string[] | null;
  pausedDates?: string[] | null;
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
    if (!av || !av.cityIds?.includes(cityId) || !av.days?.includes(weekday)) return false;
    const validTimes = getExaminerRotationTimesInWindow(ex, normalizedConfig);
    const normalizedTime = normalizeScaleTime(entry.time);
    if (!validTimes.includes(normalizedTime)) return false;
    if (isExaminerBlockedOnDateTime(ex.blockedPeriods, entry.date, normalizedTime).blocked) return false;
    return true;
  };

  const rawExisting = Array.isArray(input.existingEntries) ? input.existingEntries : [];
  const keptEntries: RotationScheduleEntry[] = [];
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
      keptEntries.push({
        id: item.id || createId(),
        date: item.date,
        time: normalizeScaleTime(item.time),
        examiner: item.examiner,
        manual: false,
      });
    }
  }

  const coveredDates = new Set(keptEntries.map(e => e.date));
  const counts = new Map<string, number>();
  const lastDate = new Map<string, string>();
  for (const ex of input.examiners) {
    counts.set(ex.id, 0);
  }
  for (const entry of keptEntries) {
    if (entry.date <= maxDate && entry.examiner) {
      counts.set(entry.examiner, (counts.get(entry.examiner) ?? 0) + 1);
      const prev = lastDate.get(entry.examiner) ?? '';
      if (entry.date > prev) lastDate.set(entry.examiner, entry.date);
    }
  }

  const warnings: string[] = [];
  const baseEligibility = findEligibleExaminersForSchool({
    schoolCity: input.schoolCity,
    config: normalizedConfig,
    examiners: input.examiners,
    cities: input.cities,
  });
  if (baseEligibility.issue) {
    warnings.push(baseEligibility.issue);
  }

  const generatedEntries: RotationScheduleEntry[] = [];
  const dates = listForwardDates(today, horizonDays);

  for (const date of dates) {
    if (coveredDates.has(date) || suppressedSet.has(date) || pausedSet.has(date)) continue;
    const weekday = scaleWeekday(date);
    if (!normalizedConfig.days.includes(weekday)) continue;
    if (isSystemDateBlockedForRotation(date, blockedDates, input.systemSettings).blocked) continue;
    if (!cityId) continue;

    const candidates: { examiner: RotationExaminerLike; time: string }[] = [];
    for (const ex of baseEligibility.eligible) {
      if (!ex.rotationAvailability?.days?.includes(weekday)) continue;
      const times = getExaminerRotationTimesInWindow(ex, normalizedConfig);
      for (const time of times) {
        if (!isExaminerBlockedOnDateTime(ex.blockedPeriods, date, time).blocked) {
          candidates.push({ examiner: ex, time });
        }
      }
    }

    if (candidates.length === 0) {
      if (baseEligibility.eligible.length > 0) {
        warnings.push(`Sem examinador disponível em ${formatRotationDateBR(date)} (${weekday}) — verifique afastamentos/férias ou horários.`);
      }
      continue;
    }

    candidates.sort((a, b) => {
      const countDiff = (counts.get(a.examiner.id) ?? 0) - (counts.get(b.examiner.id) ?? 0);
      if (countDiff !== 0) return countDiff;
      const lastDiff = (lastDate.get(a.examiner.id) ?? '').localeCompare(lastDate.get(b.examiner.id) ?? '');
      if (lastDiff !== 0) return lastDiff;
      const nameDiff = a.examiner.name.localeCompare(b.examiner.name);
      if (nameDiff !== 0) return nameDiff;
      const timeDiff = a.time.localeCompare(b.time);
      if (timeDiff !== 0) return timeDiff;
      return a.examiner.id.localeCompare(b.examiner.id);
    });

    const chosen = candidates[0];
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
