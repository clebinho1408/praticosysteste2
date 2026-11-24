import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateScheduleStatus,
  isSchoolEligibleForCnhAutoBancas,
  mergePreservedAutoCnhBancaLinks,
  planCnhRotationBancas,
  type AutoBancaExaminerLike,
  type AutoBancaScheduleLike,
  type AutoBancaSchoolLike,
} from '../functions/_cnh-auto-bancas.js';

const cities = [
  { id: 'city-itapema', name: 'ITAPEMA' },
  { id: 'city-bc', name: 'BALNEARIO CAMBORIU' },
];

const examLocations = [
  { id: 'loc-itapema', cityId: 'city-itapema' },
  { id: 'loc-bc', cityId: 'city-bc' },
];

const examiners: AutoBancaExaminerLike[] = [
  {
    id: 'ex-alpha',
    name: 'EXAMINADOR ALPHA',
    canExamCommon: true,
    examRotation: true,
    defaultMaxSlotsA: 8,
    defaultMaxSlotsB: 12,
    rotationAvailability: {
      cityIds: ['city-itapema', 'city-bc'],
      availableDates: [
        { id: 'a1', date: '2026-11-23', time: '10:30', createdAt: '2026-11-18T12:00:00Z' },
        { id: 'a2', date: '2026-11-30', time: '10:30', createdAt: '2026-11-18T12:00:00Z' },
        { id: 'a3', date: '2026-12-07', time: '10:30', createdAt: '2026-11-18T12:00:00Z' },
      ],
    },
    blockedPeriods: [],
  },
  {
    id: 'ex-beta',
    name: 'EXAMINADOR BETA',
    canExamCommon: true,
    examRotation: true,
    defaultMaxSlotsA: 10,
    defaultMaxSlotsB: 10,
    rotationAvailability: {
      cityIds: ['city-itapema', 'city-bc'],
      availableDates: [
        { id: 'b1', date: '2026-11-25', time: '15:00', createdAt: '2026-11-18T12:00:00Z' },
        { id: 'b2', date: '2026-12-02', time: '15:00', createdAt: '2026-11-18T12:00:00Z' },
        { id: 'b3', date: '2026-12-09', time: '15:00', createdAt: '2026-11-18T12:00:00Z' },
      ],
    },
    blockedPeriods: [],
  },
  {
    id: 'ex-ter',
    name: 'EXAMINADOR TERCA',
    canExamCommon: true,
    examRotation: true,
    defaultMaxSlotsA: 6,
    defaultMaxSlotsB: 14,
    rotationAvailability: {
      cityIds: ['city-bc'],
      availableDates: [
        { id: 't1', date: '2026-11-24', time: '09:00', createdAt: '2026-11-18T12:00:00Z' },
        { id: 't2', date: '2026-11-26', time: '09:00', createdAt: '2026-11-18T12:00:00Z' },
        { id: 't3', date: '2026-12-01', time: '09:00', createdAt: '2026-11-18T12:00:00Z' },
      ],
    },
    blockedPeriods: [],
  },
];

function makeSchool(overrides: Partial<AutoBancaSchoolLike> = {}): AutoBancaSchoolLike {
  return {
    id: 'school-1',
    name: 'AUTOESCOLA CNH RODIZIO',
    city: 'ITAPEMA',
    cnhBrasilProfile: true,
    examRotation: true,
    mainSchedule: {
      active: true,
      days: ['SEG', 'QUA'],
      slots: [],
      pausedDates: [],
      rotationConfig: {
        days: ['SEG', 'QUA'],
        startTime: '10:00',
        endTime: '16:00',
      },
      rotationEntries: [
        { id: 'r1', date: '2026-11-23', time: '10:30', examiner: 'ex-alpha' },
        { id: 'r2', date: '2026-11-25', time: '15:00', examiner: 'ex-beta' },
        { id: 'r3', date: '2026-11-30', time: '10:30', examiner: 'ex-alpha' },
        { id: 'r4', date: '2026-12-02', time: '15:00', examiner: 'ex-beta' },
      ],
      suppressedRotationDates: [],
    },
    provisionalSchedule: { active: false },
    ...overrides,
  };
}

let seq = 0;
const nextId = () => `auto-id-${++seq}`;

test('requires both Perfil CNH do Brasil and configured active Rodízio de Provas', () => {
  assert.equal(isSchoolEligibleForCnhAutoBancas(makeSchool()), true);
  assert.equal(isSchoolEligibleForCnhAutoBancas(makeSchool({ cnhBrasilProfile: false })), false);
  assert.equal(isSchoolEligibleForCnhAutoBancas(makeSchool({ examRotation: false })), false);
  assert.equal(
    isSchoolEligibleForCnhAutoBancas(makeSchool({ provisionalSchedule: { active: true } })),
    false,
  );
  assert.equal(
    isSchoolEligibleForCnhAutoBancas(
      makeSchool({
        mainSchedule: { active: false, rotationConfig: { days: ['SEG'], startTime: '10:00', endTime: '16:00' } },
      }),
    ),
    false,
  );
  assert.equal(
    isSchoolEligibleForCnhAutoBancas(
      makeSchool({ mainSchedule: { active: true, rotationConfig: null } }),
    ),
    false,
  );
});

test('creates bancas 2 by 2 in date sequence with exact rotation examiner, time, slots, and location', () => {
  seq = 0;
  const now = new Date('2026-11-19T08:00:00');
  const plan = planCnhRotationBancas({
    schools: [
      makeSchool(),
      makeSchool({
        id: 'school-no-cnh',
        name: 'APENAS CFC',
        city: 'BALNEARIO',
        cnhBrasilProfile: false,
        mainSchedule: {
          active: true,
          days: ['TER', 'QUI'],
          slots: [],
          pausedDates: [],
          rotationConfig: { days: ['TER', 'QUI'], startTime: '08:00', endTime: '12:00' },
          rotationEntries: [
            { id: 'cfc-1', date: '2026-11-24', time: '09:00', examiner: 'ex-ter' },
          ],
          suppressedRotationDates: [],
        },
      }),
    ],
    schedules: [],
    examiners,
    cities,
    examLocations,
    systemSettings: { defaultMaxSlotsA: 10, defaultMaxSlotsB: 10, blockWeekends: false },
    today: '2026-11-19',
    now,
    createId: nextId,
  });

  assert.equal(plan.newBancas.length, 2);
  assert.deepEqual(
    plan.newBancas.map(b => ({
      code: b.code,
      date: b.date,
      time: b.time,
      examinerIds: b.examinerIds,
      maxSlotsA: b.maxSlotsA,
      maxSlotsB: b.maxSlotsB,
      locationId: b.locationId,
      type: b.type,
      status: b.status,
    })),
    [
      {
        code: 'B1001',
        date: '2026-11-23',
        time: '10:30',
        examinerIds: ['ex-alpha'],
        maxSlotsA: 8,
        maxSlotsB: 12,
        locationId: 'loc-itapema',
        type: 'COMMON',
        status: 'OPEN',
      },
      {
        code: 'B1002',
        date: '2026-11-25',
        time: '15:00',
        examinerIds: ['ex-beta'],
        maxSlotsA: 10,
        maxSlotsB: 10,
        locationId: 'loc-itapema',
        type: 'COMMON',
        status: 'OPEN',
      },
    ],
  );
  assert.equal(plan.schoolUpdates.length, 1);
  assert.equal(plan.schoolUpdates[0].mainSchedule.autoCnhBancaLinks.length, 2);
});

test('never alters already-created bancas and completes only up to 2 open bancas', () => {
  seq = 0;
  const now = new Date('2026-11-19T08:00:00');
  const existingManual: AutoBancaScheduleLike = {
    id: 'manual-banca-1',
    code: 'B1005',
    date: '2026-11-23',
    time: '10:30',
    examinerIds: ['ex-beta'], // different examiner chosen manually
    maxSlotsA: 5,
    maxSlotsB: 5,
    type: 'COMMON',
    status: 'OPEN',
    locationId: null,
  };

  const plan = planCnhRotationBancas({
    schools: [makeSchool()],
    schedules: [existingManual],
    examiners,
    cities,
    examLocations,
    today: '2026-11-19',
    now,
    createId: nextId,
  });

  // Only 1 new banca should be created (2026-11-25), keeping B1005 untouched
  assert.equal(plan.newBancas.length, 1);
  assert.equal(plan.newBancas[0].date, '2026-11-25');
  assert.equal(plan.newBancas[0].time, '15:00');
  assert.equal(plan.newBancas[0].code, 'B1006');

  // Re-running with both bancas present must create nothing (idempotent)
  const secondRun = planCnhRotationBancas({
    schools: [
      makeSchool({
        mainSchedule: {
          ...makeSchool().mainSchedule!,
          ...plan.schoolUpdates[0].mainSchedule,
        },
      }),
    ],
    schedules: [existingManual, plan.newBancas[0]],
    examiners,
    cities,
    examLocations,
    today: '2026-11-19',
    now,
    createId: nextId,
  });
  assert.equal(secondRun.newBancas.length, 0);
});

test('when one open banca closes, automatically creates the next banca following rotation order', () => {
  seq = 0;
  const school = makeSchool({
    mainSchedule: {
      ...makeSchool().mainSchedule!,
      autoCnhBancaLinks: [
        { scheduleId: 'b1', date: '2026-11-23', time: '10:30', entryId: 'r1' },
        { scheduleId: 'b2', date: '2026-11-25', time: '15:00', entryId: 'r2' },
      ],
    },
  });

  // Simulate time < 12h before 2026-11-23 10:30 -> b1 closes (CLOSED)
  const nowAfterClose = new Date('2026-11-23T01:00:00');
  assert.equal(calculateScheduleStatus('2026-11-23', '10:30', 'OPEN', nowAfterClose), 'CLOSED');

  const existing: AutoBancaScheduleLike[] = [
    {
      id: 'b1',
      code: 'B1001',
      date: '2026-11-23',
      time: '10:30',
      examinerIds: ['ex-alpha'],
      maxSlotsA: 8,
      maxSlotsB: 12,
      type: 'COMMON',
      status: 'CLOSED',
      locationId: 'loc-itapema',
    },
    {
      id: 'b2',
      code: 'B1002',
      date: '2026-11-25',
      time: '15:00',
      examinerIds: ['ex-beta'],
      maxSlotsA: 10,
      maxSlotsB: 10,
      type: 'COMMON',
      status: 'OPEN',
      locationId: 'loc-itapema',
    },
  ];

  const plan = planCnhRotationBancas({
    schools: [school],
    schedules: existing,
    examiners,
    cities,
    examLocations,
    today: '2026-11-23',
    now: nowAfterClose,
    createId: nextId,
  });

  assert.equal(plan.newBancas.length, 1);
  assert.equal(plan.newBancas[0].date, '2026-11-30');
  assert.equal(plan.newBancas[0].time, '10:30');
  assert.deepEqual(plan.newBancas[0].examinerIds, ['ex-alpha']);
  assert.equal(plan.newBancas[0].code, 'B1003');
});

test('skips cancelled banca date and moves to next date while creating 2 per school across multiple schools', () => {
  seq = 0;
  const now = new Date('2026-11-19T08:00:00');
  const schoolA = makeSchool({
    id: 'school-a',
    name: 'AUTOESCOLA A',
    mainSchedule: {
      ...makeSchool().mainSchedule!,
      autoCnhBancaLinks: [
        { scheduleId: 'b-cancelled', date: '2026-11-23', time: '10:30', entryId: 'r1' },
      ],
    },
  });
  const schoolB = makeSchool({
    id: 'school-b',
    name: 'AUTOESCOLA B',
    city: 'BALNEARIO CAMBORIU',
    mainSchedule: {
      active: true,
      days: ['TER', 'QUI'],
      slots: [],
      pausedDates: [],
      rotationConfig: {
        days: ['TER', 'QUI'],
        startTime: '08:00',
        endTime: '12:00',
      },
      rotationEntries: [
        { id: 'b1', date: '2026-11-24', time: '09:00', examiner: 'ex-ter' },
        { id: 'b2', date: '2026-11-26', time: '09:00', examiner: 'ex-ter' },
        { id: 'b3', date: '2026-12-01', time: '09:00', examiner: 'ex-ter' },
      ],
      suppressedRotationDates: [],
    },
  });

  const cancelledBanca: AutoBancaScheduleLike = {
    id: 'b-cancelled',
    code: 'B1001',
    date: '2026-11-23',
    time: '10:30',
    examinerIds: ['ex-alpha'],
    maxSlotsA: 8,
    maxSlotsB: 12,
    type: 'COMMON',
    status: 'CANCELLED',
    locationId: 'loc-itapema',
  };

  const plan = planCnhRotationBancas({
    schools: [schoolA, schoolB],
    schedules: [cancelledBanca],
    examiners,
    cities,
    examLocations,
    today: '2026-11-19',
    now,
    createId: nextId,
  });

  const createdA = plan.newBancas.filter(b => b.locationId === 'loc-itapema');
  const createdB = plan.newBancas.filter(b => b.locationId === 'loc-bc');
  assert.deepEqual(createdA.map(b => b.date), ['2026-11-25', '2026-11-30']);
  assert.deepEqual(createdB.map(b => b.date), ['2026-11-24', '2026-11-26']);
  assert.equal(new Set(plan.newBancas.map(b => b.code)).size, 4);
});

test('never duplicates an auto-created banca if its time was edited or rotation was shuffled', () => {
  seq = 0;
  const now = new Date('2026-11-19T08:00:00');
  const editedExisting: AutoBancaScheduleLike = {
    id: 'b1',
    code: 'B1001',
    date: '2026-11-23',
    time: '11:15', // user edited time in Bancas
    examinerIds: ['ex-alpha'],
    maxSlotsA: 9,
    maxSlotsB: 11,
    type: 'COMMON',
    status: 'OPEN',
    locationId: 'loc-itapema',
  };
  const school = makeSchool({
    mainSchedule: {
      ...makeSchool().mainSchedule!,
      autoCnhBancaLinks: [
        { scheduleId: 'b1', date: '2026-11-23', time: '10:30', entryId: 'r1' },
      ],
    },
  });

  const plan = planCnhRotationBancas({
    schools: [school],
    schedules: [editedExisting],
    examiners,
    cities,
    examLocations,
    today: '2026-11-19',
    now,
    createId: nextId,
  });

  // b1 stays untouched on 2026-11-23, and only 2026-11-25 is created
  assert.equal(plan.newBancas.length, 1);
  assert.equal(plan.newBancas[0].date, '2026-11-25');
});

test('mergePreservedAutoCnhBancaLinks preserves autoCnhBancaLinks when omitted on school update', () => {
  const existingMain = {
    active: true,
    autoCnhBancaLinks: [{ scheduleId: 'b1', date: '2026-11-23', time: '10:30' }],
  };
  const merged = mergePreservedAutoCnhBancaLinks({ active: true, days: ['SEG'] }, existingMain);
  assert.deepEqual(merged.autoCnhBancaLinks, existingMain.autoCnhBancaLinks);
});
