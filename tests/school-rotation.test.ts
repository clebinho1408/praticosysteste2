import assert from 'node:assert/strict';
import test from 'node:test';
import {
  syncRollingRotationSchedule,
  syncAllSchoolsRotationSchedules,
  shuffleRotationSchedule,
  findCrossSchoolWeeklyRepeats,
  getRotationWeekKey,
  filterUpcomingRotationNext7Days,
  findEligibleExaminersForSchool,
  isExaminerBlockedOnDateTime,
  isSystemDateBlockedForRotation,
  resolveExaminerDefaultRotationTime,
  buildExaminerUpcomingSchedules,
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

test('filterUpcomingRotationNext7Days includes only today through today+7 sorted by date and time', () => {
  const entries = [
    { id: '0', date: '2026-11-17', time: '14:00', examiner: 'ex-a' }, // passado
    { id: '1', date: '2026-11-18', time: '15:00', examiner: 'ex-b' }, // hoje
    { id: '2', date: '2026-11-18', time: '10:00', examiner: 'ex-a' }, // hoje (mais cedo)
    { id: '3', date: '2026-11-23', time: '14:00', examiner: 'ex-a' }, // +5 dias
    { id: '4', date: '2026-11-25', time: '14:00', examiner: 'ex-b' }, // +7 dias (limite inclusivo)
    { id: '5', date: '2026-11-26', time: '14:00', examiner: 'ex-a' }, // +8 dias (fora dos 7 dias)
  ];

  const next7 = filterUpcomingRotationNext7Days(entries, '2026-11-18', 7);
  assert.deepEqual(next7.map(e => e.id), ['2', '1', '3', '4']);
});

test('shuffleRotationSchedule reorders examiners while keeping equal distribution, vacations, holidays, and manual overrides', () => {
  const exA = makeExaminer('ex-a', {
    name: 'ALICE',
    rotationAvailability: {
      days: ['SEG', 'QUA'],
      defaultTime: '10:30',
      examsPerDay: 1 as const,
      cityIds: ['c1'],
    },
    blockedPeriods: [
      { id: 'b1', startDate: '2026-11-25', endDate: '2026-11-25', description: 'Férias', period: 'ALL_DAY' },
    ],
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
  const config = { days: ['SEG', 'QUA'], startTime: '10:00', endTime: '16:00' };

  const initial = syncRollingRotationSchedule({
    schoolCity: 'ITAPEMA',
    config,
    examiners: [exA, exB],
    cities,
    blockedDates: [{ date: '2026-12-07', description: 'Feriado' }],
    today: '2026-11-23',
    horizonDays: 30,
  });

  // Marca uma linha como manual e uma data como suprimida
  const withManual = initial.entries
    .filter(e => e.date !== '2026-12-09')
    .map(e => e.date === '2026-11-30' ? { ...e, examiner: 'ex-a', time: '11:00', manual: true } : e);

  const shuffled = shuffleRotationSchedule({
    schoolCity: 'ITAPEMA',
    config,
    existingEntries: withManual,
    suppressedDates: ['2026-12-09'],
    examiners: [exA, exB],
    cities,
    blockedDates: [{ date: '2026-12-07', description: 'Feriado' }],
    today: '2026-11-23',
    horizonDays: 30,
  });

  assert.equal(shuffled.changed, true);
  // Feriado e suprimida ausentes
  assert.equal(shuffled.entries.some(e => e.date === '2026-12-07'), false);
  assert.equal(shuffled.entries.some(e => e.date === '2026-12-09'), false);
  // 2026-11-25 ex-a está de férias -> precisa ir para ex-b
  assert.equal(shuffled.entries.find(e => e.date === '2026-11-25')?.examiner, 'ex-b');
  // Edição manual mantida
  const manualRow = shuffled.entries.find(e => e.date === '2026-11-30');
  assert.equal(manualRow?.manual, true);
  assert.equal(manualRow?.examiner, 'ex-a');
  assert.equal(manualRow?.time, '11:00');
  // Distribuição equilibrada
  const countA = shuffled.entries.filter(e => e.examiner === 'ex-a').length;
  const countB = shuffled.entries.filter(e => e.examiner === 'ex-b').length;
  assert.ok(Math.abs(countA - countB) <= 1, `Distribuição desigual após embaralhar: A=${countA}, B=${countB}`);
});

test('planFixedScales pulls exact examiner and time per date for ROTATION_DATES and flags cross-school examiner conflict', () => {
  const schoolRot = {
    id: 's-rot',
    name: 'AUTOESCOLA RODIZIO',
    city: 'Itapema',
    examRotation: true,
    mainSchedule: {
      active: true,
      frequency: '1_WEEK' as const,
      days: ['SEG', 'QUA'],
      slots: [],
      rotationConfig: { days: ['SEG', 'QUA'], startTime: '10:00', endTime: '16:00' },
      rotationEntries: [
        { id: 'r1', date: '2026-11-23', time: '10:30', examiner: 'ex-a', manual: false },
        { id: 'r2', date: '2026-11-25', time: '15:00', examiner: 'ex-b', manual: false },
      ],
    },
    provisionalSchedule: { active: false, frequency: '1_WEEK' as const, days: [], slots: [], specificDates: [] },
  };
  const schoolConflict = {
    id: 's-other',
    name: 'AUTOESCOLA CONFLITO',
    city: 'ITAPEMA',
    examRotation: true,
    mainSchedule: {
      active: true,
      frequency: '1_WEEK' as const,
      days: ['SEG'],
      slots: [],
      rotationConfig: { days: ['SEG'], startTime: '10:00', endTime: '16:00' },
      rotationEntries: [
        { id: 'r3', date: '2026-11-23', time: '10:30', examiner: 'ex-a', manual: false },
      ],
    },
    provisionalSchedule: { active: false, frequency: '1_WEEK' as const, days: [], slots: [], specificDates: [] },
  };

  const day1 = planFixedScales({
    date: '2026-11-23',
    selectedSchoolIds: ['s-rot'],
    schools: [schoolRot],
    examiners: [makeExaminer('ex-a'), makeExaminer('ex-b')],
    cities,
    commitments: [],
  });
  assert.deepEqual(day1.plans[0].slots, [{ examinerId: 'ex-a', scheduledTime: '10:30' }]);

  const day2 = planFixedScales({
    date: '2026-11-25',
    selectedSchoolIds: ['s-rot'],
    schools: [schoolRot],
    examiners: [makeExaminer('ex-a'), makeExaminer('ex-b')],
    cities,
    commitments: [],
  });
  assert.deepEqual(day2.plans[0].slots, [{ examinerId: 'ex-b', scheduledTime: '15:00' }]);

  const conflicted = planFixedScales({
    date: '2026-11-23',
    selectedSchoolIds: ['s-rot', 's-other'],
    schools: [schoolRot, schoolConflict],
    examiners: [makeExaminer('ex-a'), makeExaminer('ex-b')],
    cities,
    commitments: [],
  });
  assert.equal(conflicted.plans.length, 1);
  assert.equal(conflicted.issues.length, 1);
  assert.match(conflicted.issues[0].reason, /já possui prova às 10:30/);
});

test('avoids repeating the same examiner across different rotation schools in the same week', () => {
  const exA = makeExaminer('ex-a', {
    name: 'ALICE',
    rotationAvailability: { days: ['SEG', 'TER', 'QUA', 'QUI'], defaultTime: '10:00', examsPerDay: 1 as const, cityIds: ['c1'] },
  });
  const exB = makeExaminer('ex-b', {
    name: 'BRUNO',
    rotationAvailability: { days: ['SEG', 'TER', 'QUA', 'QUI'], defaultTime: '11:00', examsPerDay: 1 as const, cityIds: ['c1'] },
  });
  const exC = makeExaminer('ex-c', {
    name: 'CARLOS',
    rotationAvailability: { days: ['SEG', 'TER', 'QUA', 'QUI'], defaultTime: '14:00', examsPerDay: 1 as const, cityIds: ['c1'] },
  });
  const exD = makeExaminer('ex-d', {
    name: 'DANIEL',
    rotationAvailability: { days: ['SEG', 'TER', 'QUA', 'QUI'], defaultTime: '15:00', examsPerDay: 1 as const, cityIds: ['c1'] },
  });
  const allExaminers = [exA, exB, exC, exD];

  const configA = { days: ['SEG', 'QUA'], startTime: '10:00', endTime: '16:00' };
  const configB = { days: ['TER', 'QUI'], startTime: '10:00', endTime: '16:00' };

  const syncedA = syncRollingRotationSchedule({
    currentSchoolId: 'school-a',
    schoolCity: 'ITAPEMA',
    config: configA,
    examiners: allExaminers,
    cities,
    today: '2026-11-23',
    horizonDays: 30,
  });

  const schoolA = {
    id: 'school-a',
    name: 'AUTOESCOLA ALPHA',
    city: 'ITAPEMA',
    examRotation: true,
    mainSchedule: { active: true, rotationConfig: configA, rotationEntries: syncedA.entries },
    provisionalSchedule: { active: false },
  };

  // Autoescola inativa ou em escala provisória não deve bloquear examinadores
  const inactiveOther = {
    id: 'school-inactive',
    name: 'AUTOESCOLA PROVISORIA',
    city: 'ITAPEMA',
    examRotation: true,
    mainSchedule: { active: true, rotationConfig: configB, rotationEntries: syncedA.entries },
    provisionalSchedule: { active: true },
  };

  const syncedB = syncRollingRotationSchedule({
    currentSchoolId: 'school-b',
    schoolCity: 'ITAPEMA',
    config: configB,
    otherSchools: [schoolA, inactiveOther],
    examiners: allExaminers,
    cities,
    today: '2026-11-23',
    horizonDays: 30,
  });

  assert.equal(syncedB.warnings.length, 0);
  const repeats = findCrossSchoolWeeklyRepeats({
    entries: syncedB.entries,
    otherSchools: [schoolA],
    currentSchoolId: 'school-b',
    today: '2026-11-23',
  });
  assert.equal(repeats.length, 0, `Repetição inesperada na mesma semana: ${JSON.stringify(repeats)}`);

  // Cada semana deve ter examinadores disjuntos entre Escola A e Escola B
  const weeks = new Set(syncedA.entries.map(e => getRotationWeekKey(e.date)));
  for (const wk of weeks) {
    const exInA = new Set(syncedA.entries.filter(e => getRotationWeekKey(e.date) === wk).map(e => e.examiner));
    const exInB = new Set(syncedB.entries.filter(e => getRotationWeekKey(e.date) === wk).map(e => e.examiner));
    for (const id of exInA) {
      assert.equal(exInB.has(id), false, `Examinador ${id} repetido na semana ${wk}`);
    }
  }
});

test('syncAllSchoolsRotationSchedules prioritizes constrained schools and heals existing weekly collisions', () => {
  // ex-a e ex-b só atendem SEG/QUA; ex-c e ex-d atendem SEG..QUI
  const exA = makeExaminer('ex-a', {
    name: 'ALICE',
    rotationAvailability: { days: ['SEG', 'QUA'], defaultTime: '10:00', examsPerDay: 1 as const, cityIds: ['c1'] },
  });
  const exB = makeExaminer('ex-b', {
    name: 'BRUNO',
    rotationAvailability: { days: ['SEG', 'QUA'], defaultTime: '11:00', examsPerDay: 1 as const, cityIds: ['c1'] },
  });
  const exC = makeExaminer('ex-c', {
    name: 'CARLOS',
    rotationAvailability: { days: ['SEG', 'TER', 'QUA', 'QUI'], defaultTime: '14:00', examsPerDay: 1 as const, cityIds: ['c1'] },
  });
  const exD = makeExaminer('ex-d', {
    name: 'DANIEL',
    rotationAvailability: { days: ['SEG', 'TER', 'QUA', 'QUI'], defaultTime: '15:00', examsPerDay: 1 as const, cityIds: ['c1'] },
  });

  const schoolA = {
    id: 'school-a',
    name: 'AUTOESCOLA A',
    city: 'ITAPEMA',
    examRotation: true,
    mainSchedule: {
      active: true,
      rotationConfig: { days: ['SEG', 'QUA'], startTime: '10:00', endTime: '16:00' },
      // Simula conflito legado: escola A escalou ex-c e ex-d na semana 2026-11-23
      rotationEntries: [
        { id: 'old-1', date: '2026-11-23', time: '14:00', examiner: 'ex-c', manual: false },
        { id: 'old-2', date: '2026-11-25', time: '15:00', examiner: 'ex-d', manual: false },
      ],
    },
    provisionalSchedule: { active: false },
  };
  const schoolB = {
    id: 'school-b',
    name: 'AUTOESCOLA B',
    city: 'ITAPEMA',
    examRotation: true,
    mainSchedule: {
      active: true,
      rotationConfig: { days: ['TER', 'QUI'], startTime: '10:00', endTime: '16:00' },
      rotationEntries: [],
    },
    provisionalSchedule: { active: false },
  };

  const result = syncAllSchoolsRotationSchedules({
    schools: [schoolA, schoolB],
    examiners: [exA, exB, exC, exD],
    cities,
    today: '2026-11-23',
    horizonDays: 13,
  });

  const updatedA = result.schools[0];
  const updatedB = result.schools[1];

  // Escola B só pode usar ex-c e ex-d; Escola A deve ter trocado para ex-a e ex-b na mesma semana
  const repeats = findCrossSchoolWeeklyRepeats({
    entries: updatedA.mainSchedule.rotationEntries,
    otherSchools: [updatedB],
    currentSchoolId: updatedA.id,
    today: '2026-11-23',
  });
  assert.equal(repeats.length, 0);
  assert.ok(result.updates.every(u => u.warnings.length === 0));
  assert.ok(updatedB.mainSchedule.rotationEntries.every(e => e.examiner === 'ex-c' || e.examiner === 'ex-d'));
  assert.ok(updatedA.mainSchedule.rotationEntries.every(e => e.examiner === 'ex-a' || e.examiner === 'ex-b'));
});

test('shuffleRotationSchedule avoids repeating examiners from other rotation schools in the same week', () => {
  const examinersPool = [
    makeExaminer('ex-a', { name: 'ALICE', rotationAvailability: { days: ['SEG', 'QUA'], defaultTime: '10:00', examsPerDay: 1 as const, cityIds: ['c1'] } }),
    makeExaminer('ex-b', { name: 'BRUNO', rotationAvailability: { days: ['SEG', 'QUA'], defaultTime: '11:00', examsPerDay: 1 as const, cityIds: ['c1'] } }),
    makeExaminer('ex-c', { name: 'CARLOS', rotationAvailability: { days: ['SEG', 'QUA'], defaultTime: '14:00', examsPerDay: 1 as const, cityIds: ['c1'] } }),
    makeExaminer('ex-d', { name: 'DANIEL', rotationAvailability: { days: ['SEG', 'QUA'], defaultTime: '15:00', examsPerDay: 1 as const, cityIds: ['c1'] } }),
  ];
  const config = { days: ['SEG', 'QUA'], startTime: '10:00', endTime: '16:00' };
  const schoolA = {
    id: 'school-a',
    name: 'AUTOESCOLA A',
    city: 'ITAPEMA',
    examRotation: true,
    mainSchedule: {
      active: true,
      rotationConfig: config,
      rotationEntries: [
        { id: 'a1', date: '2026-11-23', time: '10:00', examiner: 'ex-a', manual: false },
        { id: 'a2', date: '2026-11-25', time: '11:00', examiner: 'ex-b', manual: false },
        { id: 'a3', date: '2026-11-30', time: '14:00', examiner: 'ex-c', manual: false },
        { id: 'a4', date: '2026-12-02', time: '15:00', examiner: 'ex-d', manual: false },
      ],
    },
    provisionalSchedule: { active: false },
  };

  const shuffledB = shuffleRotationSchedule({
    currentSchoolId: 'school-b',
    schoolCity: 'ITAPEMA',
    config,
    otherSchools: [schoolA],
    examiners: examinersPool,
    cities,
    today: '2026-11-23',
    horizonDays: 10,
  });

  const repeats = findCrossSchoolWeeklyRepeats({
    entries: shuffledB.entries,
    otherSchools: [schoolA],
    currentSchoolId: 'school-b',
    today: '2026-11-23',
  });
  assert.equal(repeats.length, 0);
});

test('gracefully minimizes repeats and warns when total weekly slots across schools exceed available examiners', () => {
  const exA = makeExaminer('ex-a', {
    name: 'ALICE',
    rotationAvailability: { days: ['SEG', 'TER'], defaultTime: '10:00', examsPerDay: 1 as const, cityIds: ['c1'] },
  });
  const exB = makeExaminer('ex-b', {
    name: 'BRUNO',
    rotationAvailability: { days: ['SEG', 'TER'], defaultTime: '14:00', examsPerDay: 1 as const, cityIds: ['c1'] },
  });
  const schoolA = {
    id: 'school-a',
    name: 'AUTOESCOLA A',
    city: 'ITAPEMA',
    examRotation: true,
    mainSchedule: {
      active: true,
      rotationConfig: { days: ['SEG', 'TER'], startTime: '10:00', endTime: '16:00' },
      rotationEntries: [
        { id: 'a1', date: '2026-11-23', time: '10:00', examiner: 'ex-a', manual: false },
        { id: 'a2', date: '2026-11-24', time: '14:00', examiner: 'ex-b', manual: false },
      ],
    },
    provisionalSchedule: { active: false },
  };

  const syncedB = syncRollingRotationSchedule({
    currentSchoolId: 'school-b',
    schoolCity: 'ITAPEMA',
    config: { days: ['SEG', 'TER'], startTime: '10:00', endTime: '16:00' },
    otherSchools: [schoolA],
    examiners: [exA, exB],
    cities,
    today: '2026-11-23',
    horizonDays: 6,
  });

  // Na segunda 23/11 ex-a está em schoolA às 10:00 -> schoolB deve escolher ex-b (14:00) para evitar colisão de horário
  assert.equal(syncedB.entries.find(e => e.date === '2026-11-23')?.examiner, 'ex-b');
  assert.equal(syncedB.entries.find(e => e.date === '2026-11-24')?.examiner, 'ex-a');
  assert.ok(syncedB.warnings.some(w => w.includes('também está escalado')));
});

test('resolveExaminerDefaultRotationTime picks examiner default time respecting window and date blocks', () => {
  const config = { days: ['SEG', 'QUA'], startTime: '10:00', endTime: '16:00' };

  const exSingle = makeExaminer('ex-single', {
    rotationAvailability: { days: ['SEG'], defaultTime: '15:00', examsPerDay: 1 as const, cityIds: ['c1'] },
  });
  assert.equal(resolveExaminerDefaultRotationTime(exSingle, config, '2026-11-23'), '15:00');

  const exSecondInWindow = makeExaminer('ex-second', {
    rotationAvailability: {
      days: ['SEG'],
      defaultTime: '08:00', // fora da janela 10:00 - 16:00
      secondDefaultTime: '14:30', // dentro da janela
      examsPerDay: 2 as const,
      cityIds: ['c1'],
    },
  });
  assert.equal(resolveExaminerDefaultRotationTime(exSecondInWindow, config, '2026-11-23'), '14:30');

  const exHalfDayBlock = makeExaminer('ex-half-block', {
    rotationAvailability: {
      days: ['SEG'],
      defaultTime: '10:30',
      secondDefaultTime: '14:00',
      examsPerDay: 2 as const,
      cityIds: ['c1'],
    },
    blockedPeriods: [
      { id: 'b1', startDate: '2026-11-23', endDate: '2026-11-23', description: 'Médico', period: 'MORNING' },
    ],
  });
  assert.equal(resolveExaminerDefaultRotationTime(exHalfDayBlock, config, '2026-11-23'), '14:00');
  assert.equal(resolveExaminerDefaultRotationTime(exHalfDayBlock, config, '2026-11-25'), '10:30');

  const exOutsideWindowOnly = makeExaminer('ex-out', {
    rotationAvailability: { days: ['SEG'], defaultTime: '08:00', examsPerDay: 1 as const, cityIds: ['c1'] },
  });
  assert.equal(resolveExaminerDefaultRotationTime(exOutsideWindowOnly, config, '2026-11-23'), '08:00');
  assert.equal(resolveExaminerDefaultRotationTime(exOutsideWindowOnly, null), '08:00');

  const exNoAvail = makeExaminer('ex-none', { rotationAvailability: null });
  assert.equal(resolveExaminerDefaultRotationTime(exNoAvail, config, '2026-11-23'), null);
  assert.equal(resolveExaminerDefaultRotationTime(null, config), null);
});

test('buildExaminerUpcomingSchedules lists next 30 days with date, time, schoolName and drops past dates', () => {
  const ex = makeExaminer('ex-1', {
    name: 'EXAMINADOR UM',
    blockedPeriods: [
      { id: 'vac-1', startDate: '2026-11-30', endDate: '2026-11-30', description: 'Folga', period: 'ALL_DAY' },
    ],
  });
  const schools = [
    {
      id: 'sch-rot',
      name: 'AUTOESCOLA RODIZIO',
      city: 'CIDADE A',
      examRotation: true,
      mainSchedule: {
        active: true,
        rotationConfig: { days: ['SEG', 'QUA'], startTime: '08:00', endTime: '18:00' },
        rotationEntries: [
          { id: 'past', date: '2026-11-20', time: '08:00', examiner: 'ex-1', manual: false }, // passou -> deve sair
          { id: 'today', date: '2026-11-21', time: '10:00', examiner: 'ex-1', manual: false }, // hoje -> aparece
          { id: 'other', date: '2026-11-25', time: '10:00', examiner: 'ex-2', manual: false }, // outro examinador
          { id: 'd30', date: '2026-12-21', time: '14:00', examiner: 'ex-1', manual: false }, // +30 dias -> aparece
          { id: 'd31', date: '2026-12-22', time: '14:00', examiner: 'ex-1', manual: false }, // >30 dias -> fora
        ],
      },
      provisionalSchedule: { active: false, days: [], slots: [] },
    },
    {
      id: 'sch-fixed',
      name: 'AUTOESCOLA TIJUCAS',
      city: 'CIDADE A',
      examRotation: false,
      mainSchedule: {
        active: true,
        days: ['SEG'],
        slots: [{ day: 'SEG', time: '09:00', examiner: 'ex-1' }], // segundas: 2026-11-23, 2026-11-30 (férias!), 2026-12-07, 2026-12-14, 2026-12-21
        pausedDates: ['2026-12-14'],
      },
      provisionalSchedule: { active: false, days: [], slots: [] },
    },
    {
      id: 'sch-prov',
      name: 'AUTOESCOLA PROVISORIA',
      city: 'CIDADE A',
      examRotation: false,
      mainSchedule: { active: false, days: [], slots: [] },
      provisionalSchedule: {
        active: true,
        specificDates: [{ id: 'p1', date: '2026-11-26', time: '15:30', examiner: 'ex-1' }],
      },
    },
  ];
  const scheduleSlots = [
    // Já gerado para sch-fixed em 2026-11-23 -> não duplica
    { id: 'sl-1', schoolId: 'sch-fixed', examinerId: 'ex-1', scheduledDate: '2026-11-23', scheduledTime: '09:00', requestType: 'FIXA', status: 'SCHEDULED' },
  ];
  const blockedDates = [{ date: '2026-12-07', description: 'Feriado local' }];

  const items = buildExaminerUpcomingSchedules({
    examiner: ex,
    schools,
    scheduleSlots,
    blockedDates,
    today: '2026-11-21',
    horizonDays: 30,
  });

  assert.deepEqual(
    items.map(i => `${i.date}|${i.time}|${i.schoolName}`),
    [
      '2026-11-21|10:00|AUTOESCOLA RODIZIO',
      '2026-11-23|09:00|AUTOESCOLA TIJUCAS',
      '2026-11-26|15:30|AUTOESCOLA PROVISORIA',
      '2026-12-21|09:00|AUTOESCOLA TIJUCAS',
      '2026-12-21|14:00|AUTOESCOLA RODIZIO',
    ],
  );

  // Quando o dia avança para 2026-11-24, datas passadas saem automaticamente da lista
  const nextDayItems = buildExaminerUpcomingSchedules({
    examiner: ex,
    schools,
    scheduleSlots,
    blockedDates,
    today: '2026-11-24',
    horizonDays: 30,
  });
  assert.equal(nextDayItems.some(i => i.date < '2026-11-24'), false);
  assert.equal(nextDayItems[0].date, '2026-11-26');
});


