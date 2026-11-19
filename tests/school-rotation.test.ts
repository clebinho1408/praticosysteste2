import assert from 'node:assert/strict';
import test from 'node:test';
import {
  syncRollingRotationSchedule,
  findEligibleExaminersForSchool,
  isExaminerBlockedOnDateTime,
  isSystemDateBlockedForRotation,
} from '../functions/_school-rotation.js';
import {
  resolveSchoolScaleForDate,
  activeSchoolScale,
  matchesSchoolScale,
} from '../functions/_school-schedule.js';
import { planFixedScales } from '../artifacts/praticosys/src/lib/cfcFixedRotation.js';

const cities = [
  { id: 'c1', name: 'ITAPEMA' },
  { id: 'c2', name: 'TIJUCAS' },
];

const makeExaminer = (id: string, overrides: Record<string, any> = {}) => ({
  id,
  name: id.toUpperCase(),
  examRotation: true,
  canExamCommon: true,
  rotationAvailability: {
    days: ['SEG', 'QUA'],
    defaultTime: '14:00',
    secondDefaultTime: '',
    examsPerDay: 1 as const,
    cityIds: ['c1'],
  },
  blockedPeriods: [],
  ...overrides,
});

test('validates examiner examRotation, city, days, and time window 10:00 - 16:00', () => {
  const exValidSecondTime = makeExaminer('ex-valid', {
    rotationAvailability: {
      days: ['SEG'],
      defaultTime: '08:00', // fora da janela 10:00 - 16:00
      secondDefaultTime: '14:30', // dentro da janela
      examsPerDay: 2 as const,
      cityIds: ['c1'],
    },
  });
  const exNoRotation = makeExaminer('ex-no-rot', { examRotation: false });
  const exOtherCity = makeExaminer('ex-other-city', {
    rotationAvailability: {
      days: ['SEG'],
      defaultTime: '14:00',
      examsPerDay: 1 as const,
      cityIds: ['c2'],
    },
  });
  const exWrongTime = makeExaminer('ex-early', {
    rotationAvailability: {
      days: ['SEG'],
      defaultTime: '09:00',
      examsPerDay: 1 as const,
      cityIds: ['c1'],
    },
  });

  const config = { days: ['SEG'], startTime: '10:00', endTime: '16:00' };
  const result = findEligibleExaminersForSchool({
    schoolCity: 'ITAPEMA',
    config,
    examiners: [exValidSecondTime, exNoRotation, exOtherCity, exWrongTime],
    cities,
  });

  assert.deepEqual(result.eligible.map(e => e.id), ['ex-valid']);

  const synced = syncRollingRotationSchedule({
    schoolCity: 'ITAPEMA',
    config,
    examiners: [exValidSecondTime, exNoRotation, exOtherCity, exWrongTime],
    cities,
    today: '2026-11-23', // segunda-feira
    horizonDays: 30,
  });

  assert.ok(synced.entries.length >= 4);
  assert.ok(synced.entries.every(e => e.examiner === 'ex-valid' && e.time === '14:30'));
});

test('distributes exams equally across eligible examiners over 30 days', () => {
  const exA = makeExaminer('ex-a', {
    name: 'ALICE',
    rotationAvailability: {
      days: ['SEG', 'QUA'],
      defaultTime: '10:30',
      examsPerDay: 1 as const,
      cityIds: ['c1'],
    },
  });
  const exB = makeExaminer('ex-b', {
    name: 'BRUNO',
    rotationAvailability: {
      days: ['SEG', 'QUA'],
      defaultTime: '15:00',
      examsPerDay: 1 as const,
      cityIds: ['c1'],
    },
  });

  const synced = syncRollingRotationSchedule({
    schoolCity: 'ITAPEMA',
    config: { days: ['SEG', 'QUA'], startTime: '10:00', endTime: '16:00' },
    examiners: [exA, exB],
    cities,
    today: '2026-11-23',
    horizonDays: 30,
  });

  const countA = synced.entries.filter(e => e.examiner === 'ex-a').length;
  const countB = synced.entries.filter(e => e.examiner === 'ex-b').length;
  assert.ok(synced.entries.length >= 8);
  assert.ok(Math.abs(countA - countB) <= 1, `Distribuição desigual: A=${countA}, B=${countB}`);
  // Deve alternar em vez de repetir o mesmo examinador consecutivamente
  for (let i = 1; i < synced.entries.length; i++) {
    assert.notEqual(synced.entries[i].examiner, synced.entries[i - 1].examiner);
  }
});

test('respects examiner Afastamento/Férias (ALL_DAY, MORNING, AFTERNOON) and system blocked holidays/weekends', () => {
  const exMorningBlocked = makeExaminer('ex-a', {
    name: 'ANA',
    rotationAvailability: {
      days: ['SEG', 'SAB'],
      defaultTime: '10:30', // manhã (< 12:00)
      examsPerDay: 1 as const,
      cityIds: ['c1'],
    },
    blockedPeriods: [
      { id: 'b1', startDate: '2026-11-23', endDate: '2026-11-23', description: 'Consulta manhã', period: 'MORNING' },
    ],
  });
  const exAfternoonAvailable = makeExaminer('ex-b', {
    name: 'CARLOS',
    rotationAvailability: {
      days: ['SEG', 'SAB'],
      defaultTime: '14:00', // tarde (>= 12:00)
      examsPerDay: 1 as const,
      cityIds: ['c1'],
    },
    blockedPeriods: [
      { id: 'b2', startDate: '2026-11-30', endDate: '2026-11-30', description: 'Férias', period: 'ALL_DAY' },
      { id: 'b3', startDate: '2026-11-23', endDate: '2026-11-23', description: 'Manhã apenas', period: 'MORNING' },
    ],
  });

  assert.equal(isExaminerBlockedOnDateTime(exMorningBlocked.blockedPeriods, '2026-11-23', '10:30').blocked, true);
  assert.equal(isExaminerBlockedOnDateTime(exAfternoonAvailable.blockedPeriods, '2026-11-23', '14:00').blocked, false);
  assert.equal(isSystemDateBlockedForRotation('2026-11-28', [], { blockWeekends: true }).blocked, true);

  const synced = syncRollingRotationSchedule({
    schoolCity: 'ITAPEMA',
    config: { days: ['SEG', 'SAB'], startTime: '10:00', endTime: '16:00' },
    examiners: [exMorningBlocked, exAfternoonAvailable],
    cities,
    blockedDates: [{ date: '2026-12-07', description: 'Feriado Municipal' }],
    systemSettings: { blockWeekends: true },
    today: '2026-11-23',
    horizonDays: 30,
  });

  // 2026-11-23: ex-a bloqueado de manhã, ex-b livre à tarde -> ex-b
  const nov23 = synced.entries.find(e => e.date === '2026-11-23');
  assert.equal(nov23?.examiner, 'ex-b');

  // 2026-11-30: ex-b em férias ALL_DAY -> ex-a
  const nov30 = synced.entries.find(e => e.date === '2026-11-30');
  assert.equal(nov30?.examiner, 'ex-a');

  // 2026-12-07: feriado bloqueado -> ausente
  assert.equal(synced.entries.some(e => e.date === '2026-12-07'), false);

  // Sábados bloqueados por blockWeekends -> nenhum sábado presente
  assert.equal(synced.entries.some(e => e.date === '2026-11-28'), false);
});

test('rolls past dates out, tops up +30 days, and preserves manual edits and suppressed deletions', () => {
  const exA = makeExaminer('ex-a', { name: 'ALICE' });
  const exB = makeExaminer('ex-b', {
    name: 'BRUNO',
    rotationAvailability: {
      days: ['SEG', 'QUA'],
      defaultTime: '15:00',
      examsPerDay: 1 as const,
      cityIds: ['c1'],
    },
  });
  const config = { days: ['SEG'], startTime: '10:00', endTime: '16:00' };

  const initial = syncRollingRotationSchedule({
    schoolCity: 'ITAPEMA',
    config,
    examiners: [exA, exB],
    cities,
    today: '2026-11-23',
    horizonDays: 30,
  });

  // Usuário edita 2026-11-30 e exclui 2026-12-07
  const editedEntries = initial.entries
    .filter(e => e.date !== '2026-12-07')
    .map(e => e.date === '2026-11-30' ? { ...e, time: '15:30', examiner: 'ex-b', manual: true } : e);

  // Avança o relógio para 2026-11-25 (2026-11-23 passou; horizonte vai até 2026-12-25 -> inclui 2026-12-21)
  const rolled = syncRollingRotationSchedule({
    schoolCity: 'ITAPEMA',
    config,
    existingEntries: editedEntries,
    suppressedDates: ['2026-11-16', '2026-12-07'], // 11-16 expirada deve ser limpa
    examiners: [exA, exB],
    cities,
    today: '2026-11-25',
    horizonDays: 30,
  });

  assert.equal(rolled.entries.some(e => e.date === '2026-11-23'), false, 'Data passada removida');
  assert.equal(rolled.entries.some(e => e.date === '2026-12-07'), false, 'Data excluída manualmente não ressurge');
  assert.deepEqual(rolled.suppressedDates, ['2026-12-07'], 'Suppressed antigo é limpo');
  const manualEntry = rolled.entries.find(e => e.date === '2026-11-30');
  assert.equal(manualEntry?.time, '15:30');
  assert.equal(manualEntry?.examiner, 'ex-b');
  assert.equal(manualEntry?.manual, true);
  assert.equal(rolled.entries.some(e => e.date === '2026-12-21'), true, 'Nova segunda-feira dentro dos +30 dias foi adicionada');
});

test('resolveSchoolScaleForDate and planFixedScales support Escala Rodizio active as Escala Principal', () => {
  const school = {
    id: 'school-rot',
    name: 'AUTOESCOLA RODIZIO',
    city: 'ITAPEMA',
    examRotation: true,
    mainSchedule: {
      active: true,
      frequency: '1_WEEK' as const,
      days: ['SEG'],
      slots: [],
      rotationConfig: { days: ['SEG'], startTime: '10:00', endTime: '16:00' },
      rotationEntries: [
        { id: 'r1', date: '2026-11-23', time: '14:00', examiner: 'ex-a', manual: false },
      ],
    },
    provisionalSchedule: {
      active: false,
      frequency: '1_WEEK' as const,
      days: [],
      slots: [],
      specificDates: [],
    },
  };

  assert.equal(activeSchoolScale(school), 'MAIN');
  assert.equal(matchesSchoolScale(school, 'MAIN'), true);
  assert.equal(matchesSchoolScale(school, 'PROVISIONAL'), false);

  const resolved = resolveSchoolScaleForDate(school, '2026-11-23');
  assert.equal(resolved.kind, 'ROTATION_DATES');
  if (resolved.kind === 'ROTATION_DATES') {
    assert.deepEqual(resolved.entries, [{ date: '2026-11-23', time: '14:00', examiner: 'ex-a' }]);
  }

  const planned = planFixedScales({
    date: '2026-11-23',
    selectedSchoolIds: ['school-rot'],
    schools: [school],
    examiners: [makeExaminer('ex-a')],
    cities,
    commitments: [],
  });

  assert.equal(planned.issues.length, 0);
  assert.deepEqual(planned.plans[0].slots, [{ examinerId: 'ex-a', scheduledTime: '14:00' }]);
});
