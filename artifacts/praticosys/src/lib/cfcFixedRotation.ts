import type { City, DrivingSchool, Examiner, SchoolSchedule } from '../types';
import {
  businessDate,
  normalizeScaleTime,
  resolveSchoolScaleForDate,
  scaleWeekday,
} from '../../../../functions/_school-schedule';
import {
  getExaminerMaxPerDayForDate,
  getExaminerRotationTimesForDate,
  isExaminerEligibleForSchool,
} from '../../../../functions/_school-rotation';

export type FixedCommitment = {
  id?: string;
  schoolId?: string | null;
  examinerId?: string | null;
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  requestType?: string | null;
  status?: string | null;
};

export type FixedScaleSlot = { examinerId: string; scheduledTime: string };
export type FixedSchoolPlan = { school: DrivingSchool; slots: FixedScaleSlot[] };
export type FixedScaleIssue = { school: DrivingSchool; reason: string };

const validTime = (value?: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value ?? '');
const activeCommitment = (item: FixedCommitment) => item.status !== 'CANCELLED';

export function fixedScaleDay(date: string): string {
  return scaleWeekday(date);
}

export function activeSchoolSchedule(school: DrivingSchool): SchoolSchedule | null {
  return school.provisionalSchedule?.active
    ? school.provisionalSchedule
    : school.mainSchedule?.active ? school.mainSchedule : null;
}

export function rotationCandidates(
  school: DrivingSchool,
  day: string,
  examiners: Examiner[],
  cities: City[],
  date?: string,
): { eligible: Examiner[]; reason?: string } {
  if (!school.examRotation) {
    return { eligible: [], reason: 'Rodízio de Provas desativado para esta autoescola.' };
  }
  const targetCity = (school.city ?? '').trim().toUpperCase();
  const city = targetCity ? cities.find(item => item.name.trim().toUpperCase() === targetCity) : undefined;
  const hasSchoolBasedSelection = examiners.some(ex => Array.isArray(ex.rotationAvailability?.schoolIds));
  if (!city && !hasSchoolBasedSelection) {
    return { eligible: [], reason: 'Cidade da autoescola não cadastrada ou não informada.' };
  }

  const today = businessDate();
  const eligible = examiners.filter(examiner => {
    if (!isExaminerEligibleForSchool(examiner, school, cities)) return false;
    const availability = examiner.rotationAvailability!;
    if (Array.isArray(availability.availableDates)) {
      if (date) {
        return getExaminerRotationTimesForDate(examiner, date).length > 0;
      }
      return availability.availableDates.some(
        slot => slot.date >= today && scaleWeekday(slot.date) === day && validTime(normalizeScaleTime(slot.time)),
      );
    }
    return Boolean(
      availability.days?.includes(day) &&
      validTime(availability.defaultTime) &&
      (availability.examsPerDay === 1 ||
        (availability.examsPerDay === 2 && validTime(availability.secondDefaultTime) &&
          availability.secondDefaultTime !== availability.defaultTime)),
    );
  });
  return eligible.length
    ? { eligible }
    : { eligible: [], reason: 'Nenhum examinador com rodízio, autoescola, data e horários compatíveis.' };
}

export function planFixedScales(input: {
  date: string;
  selectedSchoolIds: string[];
  schools: DrivingSchool[];
  examiners: Examiner[];
  cities: City[];
  commitments: FixedCommitment[];
}): { plans: FixedSchoolPlan[]; issues: FixedScaleIssue[] } {
  const { date, schools, examiners, cities } = input;
  const day = fixedScaleDay(date);
  const selected = new Set(input.selectedSchoolIds);
  const commitments = input.commitments.filter(activeCommitment);
  const plans: FixedSchoolPlan[] = [];
  const issues: FixedScaleIssue[] = [];
  const reserved: FixedCommitment[] = [];

  // Reservar primeiro escalas com examinador/horário concretos e, depois, escolas com menos opções no rodízio semanal.
  for (const school of schools.filter(s => selected.has(s.id) && s.id !== 'PCD' && s.id !== 'CNH_BRASIL')
    .sort((a, b) => {
      const options = (item: DrivingSchool) => {
        if (!item.examRotation) return -1;
        const itemScale = resolveSchoolScaleForDate(item, date);
        if (itemScale.kind === 'ROTATION_DATES' || itemScale.kind === 'PROVISIONAL_DATES') return -1;
        return rotationCandidates(item, day, examiners, cities, date).eligible.length;
      };
      return options(a) - options(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    })) {
    const resolved = resolveSchoolScaleForDate(school, date);
    const resolveExaminerId = (idOrName: string) =>
      examiners.find(ex => ex.id === idOrName || ex.name === idOrName)?.id ?? idOrName;
    const findExaminerConflict = (slotsToCheck: FixedScaleSlot[]) => {
      for (const slot of slotsToCheck) {
        const hasConflict = [...commitments, ...reserved].some(item =>
          item.examinerId === slot.examinerId &&
          item.scheduledDate === date &&
          normalizeScaleTime(item.scheduledTime) === slot.scheduledTime);
        if (hasConflict) {
          const exName = examiners.find(ex => ex.id === slot.examinerId)?.name ?? slot.examinerId;
          return `Examinador ${exName} já possui prova às ${slot.scheduledTime} nesta data.`;
        }
      }
      return null;
    };

    // ── Escala Provisória com specificDates ──────────────────────────────────
    if (resolved.kind === 'PROVISIONAL_DATES') {
      const provDates = resolved.specificDates;
      if (provDates.length === 0) {
        issues.push({ school, reason: 'Escala provisória ativa, mas sem data específica configurada para este dia.' });
        continue;
      }
      if (commitments.some(item => item.schoolId === school.id &&
        item.scheduledDate === date && item.requestType === 'FIXA')) {
        issues.push({ school, reason: 'Já existe escala fixa para esta data; nenhuma prova foi duplicada.' });
        continue;
      }
      const slots: FixedScaleSlot[] = provDates.map(d => ({ examinerId: resolveExaminerId(d.examiner), scheduledTime: d.time }));
      if (new Set(slots.map(s => s.scheduledTime)).size !== slots.length) {
        issues.push({ school, reason: 'A escala provisória contém horários repetidos para esta data.' });
        continue;
      }
      const conflictReason = findExaminerConflict(slots);
      if (conflictReason) {
        issues.push({ school, reason: conflictReason });
        continue;
      }
      plans.push({ school, slots });
      reserved.push(...slots.map(slot => ({ ...slot, schoolId: school.id, scheduledDate: date })));
      continue;
    }

    if (resolved.kind === 'PAUSED') {
      issues.push({ school, reason: 'Escala Principal pausada nesta data.' });
      continue;
    }

    // ── Escala Rodízio (cronograma de 30 dias com datas e examinadores) ───────
    if (resolved.kind === 'ROTATION_DATES') {
      if (resolved.entries.length === 0) {
        issues.push({ school, reason: 'Escala Rodízio ativa, mas sem data configurada para este dia.' });
        continue;
      }
      if (commitments.some(item => item.schoolId === school.id &&
        item.scheduledDate === date && item.requestType === 'FIXA')) {
        issues.push({ school, reason: 'Já existe escala fixa para esta data; nenhuma prova foi duplicada.' });
        continue;
      }
      const slots: FixedScaleSlot[] = resolved.entries.map(e => ({ examinerId: resolveExaminerId(e.examiner), scheduledTime: e.time }));
      if (new Set(slots.map(s => s.scheduledTime)).size !== slots.length) {
        issues.push({ school, reason: 'A Escala Rodízio contém horários repetidos para esta data.' });
        continue;
      }
      const conflictReason = findExaminerConflict(slots);
      if (conflictReason) {
        issues.push({ school, reason: conflictReason });
        continue;
      }
      plans.push({ school, slots });
      reserved.push(...slots.map(slot => ({ ...slot, schoolId: school.id, scheduledDate: date })));
      continue;
    }

    // ── Escala Semanal (Principal ou Provisória legada por days[] + slots[]) ─
    if (resolved.kind === 'INACTIVE') {
      issues.push({ school, reason: 'Sem escala ativa para o dia selecionado.' });
      continue;
    }

    const matchingSlots = resolved.slots;
    if (!matchingSlots.length) {
      issues.push({ school, reason: 'A escala ativa não tem provas configuradas para este dia.' });
      continue;
    }
    if (commitments.some(item => item.schoolId === school.id &&
      item.scheduledDate === date && item.requestType === 'FIXA')) {
      issues.push({ school, reason: 'Já existe escala fixa para esta data; nenhuma prova foi duplicada.' });
      continue;
    }

    if (!school.examRotation) {
      const slots = matchingSlots.map(slot => ({
        examinerId: slot.examiner,
        scheduledTime: slot.time,
      }));
      if (new Set(slots.map(slot => slot.scheduledTime)).size !== slots.length) {
        issues.push({ school, reason: 'A escala ativa contém horários repetidos.' });
        continue;
      }
      const conflictReason = findExaminerConflict(slots);
      if (conflictReason) {
        issues.push({ school, reason: conflictReason });
        continue;
      }
      plans.push({ school, slots });
      reserved.push(...slots.map(slot => ({ ...slot, schoolId: school.id, scheduledDate: date })));
      continue;
    }

    const { eligible, reason } = rotationCandidates(school, day, examiners, cities, date);
    if (reason) {
      issues.push({ school, reason });
      continue;
    }

    const allocated: FixedScaleSlot[] = [];
    const tentative: FixedCommitment[] = [];
    for (const _slot of matchingSlots) {
      const choices = eligible.flatMap(examiner => {
        const times = getExaminerRotationTimesForDate(examiner, date);
        const maxPerDay = getExaminerMaxPerDayForDate(examiner, date);
        const appointments = [...commitments, ...reserved, ...tentative]
          .filter(item => item.examinerId === examiner.id && item.scheduledDate === date);
        // Candidatos e vagas podem representar a mesma prova. Contar a prova uma vez só.
        const occupied = new Set(appointments.map(item =>
          `${item.schoolId ?? ''}|${item.scheduledTime ?? item.id ?? ''}`));
        if (occupied.size >= maxPerDay) return [];
        return times.flatMap((time, order) =>
          !appointments.some(item => item.scheduledTime === time) &&
          ![...reserved, ...tentative].some(item =>
            item.schoolId === school.id && item.scheduledTime === time)
            ? [{ examiner, time, order, dailyLoad: occupied.size }]
            : []);
      });

      choices.sort((a, b) => {
        const history = (examinerId: string) => commitments.filter(item =>
          item.schoolId === school.id && item.examinerId === examinerId &&
          item.requestType === 'FIXA' && !!item.scheduledDate && item.scheduledDate < date);
        const distinctHistory = (examinerId: string) => {
          const unique = new Map<string, FixedCommitment>();
          for (const item of history(examinerId)) {
            unique.set(`${item.scheduledDate}|${item.scheduledTime}`, item);
          }
          return [...unique.values()];
        };
        const aHistory = distinctHistory(a.examiner.id);
        const bHistory = distinctHistory(b.examiner.id);
        const aSameDay = tentative.some(item => item.examinerId === a.examiner.id);
        const bSameDay = tentative.some(item => item.examinerId === b.examiner.id);
        return Number(bSameDay) - Number(aSameDay) ||
          aHistory.length - bHistory.length ||
          (aHistory.map(item => item.scheduledDate!).sort().at(-1) ?? '').localeCompare(
            bHistory.map(item => item.scheduledDate!).sort().at(-1) ?? '') ||
          a.dailyLoad - b.dailyLoad ||
          a.examiner.id.localeCompare(b.examiner.id) ||
          a.order - b.order;
      });

      const chosen = choices[0];
      if (!chosen) break;
      allocated.push({ examinerId: chosen.examiner.id, scheduledTime: chosen.time });
      tentative.push({ schoolId: school.id, examinerId: chosen.examiner.id,
        scheduledDate: date, scheduledTime: chosen.time });
    }
    if (allocated.length !== matchingSlots.length) {
      issues.push({ school, reason: 'Examinadores sem capacidade ou horários livres para todas as provas do dia.' });
      continue;
    }
    plans.push({ school, slots: allocated });
    reserved.push(...tentative);
  }
  return { plans, issues };
}