import test from 'node:test';
import assert from 'node:assert/strict';
import {
  drivingSchools,
  examiners,
  examSchedules,
  cfcScheduleSlots,
  cfcRequests,
  cnhbrasilRequests,
  blockedDates,
  systemSettings,
} from '../db/schema.js';
import {
  buildExaminerUpcomingSchedules,
  findSchoolsSchedulingExaminerRotationSlot,
  getExaminerAvailableSlotStatus,
  removeExaminerAvailableDateSlot,
  resolveExaminerAvailableTimeForSelectedDate,
  syncAllSchoolsRotationSchedules,
  updateExaminerAvailableDateSlot,
} from '../functions/_school-rotation.js';
import { sanitizeAdminExaminerRotationAvailability } from '../functions/_examiner-self-rotation.js';
import {
  cleanupDerivedSchedulesOnSchoolDelete,
  syncDerivedSchedulesOnSchoolUpdate,
} from '../functions/_school-sync-propagation.js';

function createMemoryDb(seed: {
  drivingSchools?: any[];
  examiners?: any[];
  examSchedules?: any[];
  cfcScheduleSlots?: any[];
  cfcRequests?: any[];
  cnhbrasilRequests?: any[];
  blockedDates?: any[];
  systemSettings?: any[];
}) {
  const store = new Map<any, any[]>([
    [drivingSchools, [...(seed.drivingSchools ?? [])]],
    [examiners, [...(seed.examiners ?? [])]],
    [examSchedules, [...(seed.examSchedules ?? [])]],
    [cfcScheduleSlots, [...(seed.cfcScheduleSlots ?? [])]],
    [cfcRequests, [...(seed.cfcRequests ?? [])]],
    [cnhbrasilRequests, [...(seed.cnhbrasilRequests ?? [])]],
    [blockedDates, [...(seed.blockedDates ?? [])]],
    [systemSettings, [...(seed.systemSettings ?? [])]],
  ]);

  const matchEq = (table: any, row: any, whereClause: any): boolean => {
    if (!whereClause) return true;
    const chunks = whereClause?.queryChunks;
    if (!Array.isArray(chunks)) return true;
    let colName: string | null = null;
    let expected: any = undefined;
    for (const chunk of chunks) {
      if (chunk && typeof chunk === 'object' && 'name' in chunk && 'table' in chunk) {
        colName = chunk.name;
      } else if (chunk && typeof chunk === 'object' && 'encoder' in chunk && 'value' in chunk) {
        expected = chunk.value;
      }
    }
    if (!colName) return true;
    for (const [propKey, colDef] of Object.entries(table)) {
      if ((colDef as any)?.name === colName) {
        return row[propKey] === expected;
      }
    }
    return row[colName] === expected;
  };

  return {
    store,
    select() {
      return {
        from(table: any) {
          const getRows = () => [...(store.get(table) ?? [])];
          return {
            then(resolve: any, reject: any) {
              return Promise.resolve(getRows()).then(resolve, reject);
            },
            where(whereClause: any) {
              const filtered = getRows().filter(r => matchEq(table, r, whereClause));
              return {
                then(resolve: any, reject: any) {
                  return Promise.resolve(filtered).then(resolve, reject);
                },
                limit(n: number) {
                  return Promise.resolve(filtered.slice(0, n));
                },
              };
            },
            limit(n: number) {
              return Promise.resolve(getRows().slice(0, n));
            },
          };
        },
      };
    },
    insert(table: any) {
      return {
        values(rowOrRows: any) {
          const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
          const target = store.get(table) ?? [];
          for (const r of rows) target.push({ ...r });
          store.set(table, target);
          return Promise.resolve(rows);
        },
      };
    },
    update(table: any) {
      return {
        set(updates: any) {
          return {
            where(whereClause: any) {
              const target = store.get(table) ?? [];
              const updated: any[] = [];
              const next = target.map(row => {
                if (matchEq(table, row, whereClause)) {
                  const merged = { ...row, ...updates };
                  updated.push(merged);
                  return merged;
                }
                return row;
              });
              store.set(table, next);
              return Promise.resolve(updated);
            },
          };
        },
      };
    },
    delete(table: any) {
      return {
        where(whereClause: any) {
          const target = store.get(table) ?? [];
          store.set(table, target.filter(row => !matchEq(table, row, whereClause)));
          return Promise.resolve();
        },
      };
    },
  };
}

const baseExaminers = [
  {
    id: 'ex-a',
    name: 'EXAMINADOR ALFA',
    examRotation: true,
    defaultMaxSlotsA: 8,
    defaultMaxSlotsB: 10,
    blockedPeriods: [],
    rotationAvailability: {
      schoolIds: ['school-1'],
      availableDates: [
        { id: 'd1', date: '2026-12-01', time: '08:30', createdAt: '2026-11-20T10:00:00Z' },
        { id: 'd2', date: '2026-12-03', time: '14:00', createdAt: '2026-11-20T10:00:00Z' },
      ],
    },
  },
  {
    id: 'ex-b',
    name: 'EXAMINADOR BETA',
    examRotation: true,
    defaultMaxSlotsA: 12,
    defaultMaxSlotsB: 12,
    blockedPeriods: [],
    rotationAvailability: {
      schoolIds: ['school-1'],
      availableDates: [
        { id: 'b1', date: '2026-12-01', time: '08:30', createdAt: '2026-11-20T10:00:00Z' },
      ],
    },
  },
];

test('getExaminerAvailableSlotStatus returns Agendado when scheduled on school Escala Rodízio and Disponível otherwise', () => {
  const schools = [
    {
      id: 'school-rot',
      name: 'AUTOESCOLA RODIZIO',
      examRotation: true,
      mainSchedule: {
        active: true,
        days: ['TER'],
        slots: [],
        pausedDates: ['2026-12-08'],
        suppressedRotationDates: ['2026-12-15'],
        rotationEntries: [
          { id: 'e1', date: '2026-12-01', time: '08:30', examiner: 'ex-a' },
          { id: 'e2', date: '2026-12-08', time: '08:30', examiner: 'ex-a' },
          { id: 'e3', date: '2026-12-15', time: '08:30', examiner: 'ex-a' },
        ],
      },
    },
    {
      id: 'school-fixed',
      name: 'AUTOESCOLA FIXA',
      examRotation: false,
      mainSchedule: {
        active: true,
        days: ['QUI'],
        slots: [],
        rotationEntries: [
          { id: 'e4', date: '2026-12-03', time: '14:00', examiner: 'ex-a' },
        ],
      },
    },
  ];

  assert.equal(
    getExaminerAvailableSlotStatus({
      examinerId: 'ex-a',
      examinerName: 'EXAMINADOR ALFA',
      date: '2026-12-01',
      time: '8:30',
      schools: schools as any,
    }),
    'Agendado',
  );

  assert.deepEqual(
    findSchoolsSchedulingExaminerRotationSlot({
      examinerId: 'ex-a',
      examinerName: 'EXAMINADOR ALFA',
      date: '2026-12-01',
      time: '08:30',
      schools: schools as any,
    }),
    [{ id: 'school-rot', name: 'AUTOESCOLA RODIZIO' }],
  );

  // Different time -> Disponível
  assert.equal(
    getExaminerAvailableSlotStatus({
      examinerId: 'ex-a',
      examinerName: 'EXAMINADOR ALFA',
      date: '2026-12-01',
      time: '10:00',
      schools: schools as any,
    }),
    'Disponível',
  );

  // Paused or suppressed date -> Disponível
  assert.equal(
    getExaminerAvailableSlotStatus({
      examinerId: 'ex-a',
      examinerName: 'EXAMINADOR ALFA',
      date: '2026-12-08',
      time: '08:30',
      schools: schools as any,
    }),
    'Disponível',
  );
  assert.equal(
    getExaminerAvailableSlotStatus({
      examinerId: 'ex-a',
      examinerName: 'EXAMINADOR ALFA',
      date: '2026-12-15',
      time: '08:30',
      schools: schools as any,
    }),
    'Disponível',
  );

  // School without examRotation -> Disponível
  assert.equal(
    getExaminerAvailableSlotStatus({
      examinerId: 'ex-a',
      examinerName: 'EXAMINADOR ALFA',
      date: '2026-12-03',
      time: '14:00',
      schools: schools as any,
    }),
    'Disponível',
  );
});

test('swapping examiner on fixed school schedule immediately updates future cfcScheduleSlots and cfcRequests so old examiner disappears from Escalas', async () => {
  const currentSchool = {
    id: 'school-1',
    name: 'AUTOESCOLA MODELO',
    examRotation: false,
    cnhBrasilProfile: false,
    mainSchedule: {
      active: true,
      frequency: 'WEEKLY',
      days: ['TER'],
      slots: [{ day: '', time: '08:30', examiner: 'ex-a' }],
      pausedDates: [],
    },
    provisionalSchedule: { active: false, days: [], slots: [], specificDates: [] },
  };
  const updatedSchool = {
    ...currentSchool,
    mainSchedule: {
      ...currentSchool.mainSchedule,
      slots: [{ day: '', time: '08:30', examiner: 'ex-b' }],
    },
  };

  const mem = createMemoryDb({
    drivingSchools: [updatedSchool],
    examiners: baseExaminers,
    cfcScheduleSlots: [
      {
        id: 'auto-fixed:school-1:2026-12-01:0:0',
        schoolId: 'school-1',
        examType: 'COMMON',
        requestType: 'FIXA',
        intendedCategory: 'A,B',
        scheduledDate: '2026-12-01',
        scheduledTime: '08:30',
        examinerId: 'ex-a',
        status: 'SCHEDULED',
        attendanceConfirmed: true,
      },
    ],
    cfcRequests: [
      {
        id: 'req-student-1',
        schoolId: 'school-1',
        requestType: 'FIXA',
        status: 'SCHEDULED',
        scheduledDate: '2026-12-01',
        scheduledTime: '08:30',
        examinerId: 'ex-a',
      },
    ],
  });

  const result = await syncDerivedSchedulesOnSchoolUpdate(
    mem,
    {
      drivingSchools,
      examiners,
      examSchedules,
      cfcScheduleSlots,
      cfcRequests,
      cnhbrasilRequests,
      blockedDates,
      systemSettings,
    },
    { currentSchool, updatedSchool, today: '2026-11-24' },
  );

  assert.deepEqual(result.deletedSlotIds, ['auto-fixed:school-1:2026-12-01:0:0']);
  assert.equal(result.createdSlotIds.length, 1);
  assert.deepEqual(result.updatedRequestIds, ['req-student-1']);

  const updatedSlots = mem.store.get(cfcScheduleSlots)!;
  const updatedReqs = mem.store.get(cfcRequests)!;
  assert.equal(updatedSlots.length, 1);
  assert.equal(updatedSlots[0].examinerId, 'ex-b');
  assert.equal(updatedReqs[0].examinerId, 'ex-b');

  // Examinador A NÃO pode mais aparecer em Escalas; Examinador B DEVE aparecer
  const exASchedules = buildExaminerUpcomingSchedules({
    examiner: baseExaminers[0],
    schools: [updatedSchool as any],
    scheduleSlots: updatedSlots,
    requests: updatedReqs,
    today: '2026-11-24',
  });
  const exBSchedules = buildExaminerUpcomingSchedules({
    examiner: baseExaminers[1],
    schools: [updatedSchool as any],
    scheduleSlots: updatedSlots,
    requests: updatedReqs,
    today: '2026-11-24',
  });
  assert.equal(exASchedules.length, 0);
  assert.ok(exBSchedules.some(item => item.date === '2026-12-01' && item.schoolId === 'school-1'));
});

test('pausing date or deactivating school removes future empty FIXA cfcScheduleSlots and empty OPEN auto-linked CNH bancas', async () => {
  const currentSchool = {
    id: 'school-rot',
    name: 'AUTOESCOLA RODIZIO',
    examRotation: true,
    cnhBrasilProfile: true,
    mainSchedule: {
      active: true,
      days: ['TER'],
      slots: [],
      pausedDates: [],
      rotationConfig: { days: ['TER'], startTime: '08:00', endTime: '12:00' },
      rotationEntries: [
        { id: 'rot-1', date: '2026-12-01', time: '08:30', examiner: 'ex-a' },
        { id: 'rot-2', date: '2026-12-08', time: '08:30', examiner: 'ex-a' },
      ],
      autoCnhBancaLinks: [
        { scheduleId: 'banca-empty', date: '2026-12-01', time: '08:30', entryId: 'rot-1' },
        { scheduleId: 'banca-with-student', date: '2026-12-08', time: '08:30', entryId: 'rot-2' },
      ],
    },
    provisionalSchedule: { active: false },
  };

  // Usuário pausa 2026-12-01 e troca examinador da data 2026-12-08 mantendo o horário
  const updatedSchool = {
    ...currentSchool,
    mainSchedule: {
      ...currentSchool.mainSchedule,
      pausedDates: ['2026-12-01'],
      rotationEntries: [
        { id: 'rot-2', date: '2026-12-08', time: '08:30', examiner: 'ex-b' },
      ],
    },
  };

  const mem = createMemoryDb({
    drivingSchools: [updatedSchool],
    examiners: baseExaminers,
    examSchedules: [
      { id: 'banca-empty', code: 'B1001', date: '2026-12-01', time: '08:30', examinerIds: ['ex-a'], type: 'COMMON', status: 'OPEN', maxSlotsA: 8, maxSlotsB: 10 },
      { id: 'banca-with-student', code: 'B1002', date: '2026-12-08', time: '08:30', examinerIds: ['ex-a'], type: 'COMMON', status: 'OPEN', maxSlotsA: 8, maxSlotsB: 10 },
    ],
    cnhbrasilRequests: [
      { id: 'cnh-req-1', scheduleId: 'banca-with-student', status: 'SCHEDULED' },
    ],
    cfcScheduleSlots: [
      { id: 'auto-fixed:school-rot:2026-12-01:0:0', schoolId: 'school-rot', requestType: 'FIXA', status: 'SCHEDULED', scheduledDate: '2026-12-01', scheduledTime: '08:30', examinerId: 'ex-a' },
    ],
  });

  const result = await syncDerivedSchedulesOnSchoolUpdate(
    mem,
    {
      drivingSchools,
      examiners,
      examSchedules,
      cfcScheduleSlots,
      cfcRequests,
      cnhbrasilRequests,
      blockedDates,
      systemSettings,
    },
    { currentSchool, updatedSchool, today: '2026-11-24', now: new Date('2026-11-24T09:00:00Z') },
  );

  assert.deepEqual(result.deletedSlotIds, ['auto-fixed:school-rot:2026-12-01:0:0']);
  assert.deepEqual(result.deletedBancaIds, ['banca-empty']);
  assert.deepEqual(result.updatedBancaIds, ['banca-with-student']);

  const bancas = mem.store.get(examSchedules)!;
  assert.equal(bancas.length, 1);
  assert.equal(bancas[0].id, 'banca-with-student');
  assert.deepEqual(bancas[0].examinerIds, ['ex-b']);

  const exASchedules = buildExaminerUpcomingSchedules({
    examiner: baseExaminers[0],
    schools: [updatedSchool as any],
    scheduleSlots: mem.store.get(cfcScheduleSlots)!,
    cnhSchedules: bancas,
    today: '2026-11-24',
  });
  assert.equal(exASchedules.length, 0);

  const exBSchedules = buildExaminerUpcomingSchedules({
    examiner: baseExaminers[1],
    schools: [updatedSchool as any],
    scheduleSlots: mem.store.get(cfcScheduleSlots)!,
    cnhSchedules: bancas,
    today: '2026-11-24',
  });
  assert.deepEqual(exBSchedules.map(s => s.date), ['2026-12-08']);
});

test('cleanupDerivedSchedulesOnSchoolDelete removes future empty FIXA slots and empty OPEN linked bancas', async () => {
  const school = {
    id: 'school-del',
    mainSchedule: {
      autoCnhBancaLinks: [{ scheduleId: 'b-del', date: '2026-12-10', time: '09:00' }],
    },
  };
  const mem = createMemoryDb({
    cfcScheduleSlots: [
      { id: 'slot-1', schoolId: 'school-del', scheduledDate: '2026-12-05', requestType: 'FIXA', status: 'SCHEDULED' },
    ],
    examSchedules: [
      { id: 'b-del', date: '2026-12-10', time: '09:00', status: 'OPEN', examinerIds: ['ex-a'] },
    ],
    cnhbrasilRequests: [],
  });

  const res = await cleanupDerivedSchedulesOnSchoolDelete(
    mem,
    { cfcScheduleSlots, examSchedules, cnhbrasilRequests },
    { school, today: '2026-11-24', now: new Date('2026-11-24T09:00:00Z') },
  );

  assert.deepEqual(res.deletedSlotIds, ['slot-1']);
  assert.deepEqual(res.deletedBancaIds, ['b-del']);
  assert.equal(mem.store.get(cfcScheduleSlots)!.length, 0);
  assert.equal(mem.store.get(examSchedules)!.length, 0);
});

test('updateExaminerAvailableDateSlot edits date and time, validates rules, and preserves metadata', () => {
  const initialSlots = [
    { id: 'slot-1', date: '2026-12-01', time: '08:30', createdAt: '2026-11-20T10:00:00Z' },
    { id: 'slot-2', date: '2026-12-03', time: '14:00', createdAt: '2026-11-20T11:00:00Z' },
  ];

  // Edits slot-1 to a later date/time and checks sorting + HH:mm normalization + preserved id/createdAt
  const edited = updateExaminerAvailableDateSlot({
    slots: initialSlots,
    slotId: 'slot-1',
    date: '2026-12-05',
    time: '9:05',
    today: '2026-11-24',
  });
  assert.equal(edited.ok, true);
  if (edited.ok) {
    assert.deepEqual(
      edited.availableDates.map(s => ({ id: s.id, date: s.date, time: s.time, createdAt: s.createdAt })),
      [
        { id: 'slot-2', date: '2026-12-03', time: '14:00', createdAt: '2026-11-20T11:00:00Z' },
        { id: 'slot-1', date: '2026-12-05', time: '09:05', createdAt: '2026-11-20T10:00:00Z' },
      ],
    );
  }

  // Rejects duplicate date+time against another slot
  const dup = updateExaminerAvailableDateSlot({
    slots: initialSlots,
    slotId: 'slot-1',
    date: '2026-12-03',
    time: '14:00',
    today: '2026-11-24',
  });
  assert.equal(dup.ok, false);

  // Rejects past date
  const past = updateExaminerAvailableDateSlot({
    slots: initialSlots,
    slotId: 'slot-1',
    date: '2026-11-20',
    time: '08:30',
    today: '2026-11-24',
  });
  assert.equal(past.ok, false);

  // Rejects invalid time
  const badTime = updateExaminerAvailableDateSlot({
    slots: initialSlots,
    slotId: 'slot-1',
    date: '2026-12-01',
    time: '99:99',
    today: '2026-11-24',
  });
  assert.equal(badTime.ok, false);
});

test('removeExaminerAvailableDateSlot and sanitizeAdminExaminerRotationAvailability persist edits/deletions and resync rotation', () => {
  const initialSlots = [
    { id: 'slot-1', date: '2026-12-01', time: '08:30', createdAt: '2026-11-20T10:00:00Z' },
    { id: 'slot-2', date: '2026-12-03', time: '14:00', createdAt: '2026-11-20T11:00:00Z' },
  ];

  const afterRemove = removeExaminerAvailableDateSlot({
    slots: initialSlots,
    slotId: 'slot-1',
    today: '2026-11-24',
  });
  assert.deepEqual(afterRemove.map(s => s.id), ['slot-2']);

  const sanitized = sanitizeAdminExaminerRotationAvailability(
    {
      schoolIds: ['school-rot'],
      availableDates: [
        { id: 'slot-2', date: '2026-12-08', time: '9:00', createdAt: '2026-11-20T11:00:00Z' },
        { id: 'dup', date: '2026-12-08', time: '09:00', createdAt: '2026-11-20T12:00:00Z' },
        { id: 'past', date: '2026-11-10', time: '08:00', createdAt: '2026-11-01T10:00:00Z' },
      ],
    },
    { schoolIds: ['school-rot'], availableDates: initialSlots },
    '2026-11-24',
  );
  assert.deepEqual(sanitized.availableDates, [
    { id: 'slot-2', date: '2026-12-08', time: '09:00', createdAt: '2026-11-20T11:00:00Z' },
  ]);

  // School had an auto entry on 2026-12-01 08:30 for ex-a; after admin moves slot to 2026-12-08 09:00, sync moves entry cleanly
  const schools = [
    {
      id: 'school-rot',
      name: 'AUTOESCOLA RODIZIO',
      examRotation: true,
      mainSchedule: {
        active: true,
        days: ['TER'],
        slots: [],
        rotationConfig: { days: ['TER'], startTime: '08:00', endTime: '12:00' },
        rotationEntries: [
          { id: 'auto-old', date: '2026-12-01', time: '08:30', examiner: 'ex-a', manual: false },
        ],
      },
    },
  ];
  const updatedExaminers = [
    {
      id: 'ex-a',
      name: 'EXAMINADOR ALFA',
      examRotation: true,
      rotationAvailability: sanitized,
    },
  ];
  const resync = syncAllSchoolsRotationSchedules({
    schools: schools as any,
    examiners: updatedExaminers as any,
    cities: [],
    today: '2026-11-24',
    horizonDays: 30,
  });

  const syncedEntries = resync.schools[0].mainSchedule!.rotationEntries!;
  assert.equal(syncedEntries.some(e => e.date === '2026-12-01'), false);
  assert.equal(syncedEntries.some(e => e.date === '2026-12-08' && e.time === '09:00' && e.examiner === 'ex-a'), true);
  assert.equal(
    getExaminerAvailableSlotStatus({
      examinerId: 'ex-a',
      date: '2026-12-08',
      time: '09:00',
      schools: resync.schools as any,
    }),
    'Agendado',
  );
});

test('resolveExaminerAvailableTimeForSelectedDate returns examiner available time only when selected date matches availableDates', () => {
  const config = { days: ['TER', 'QUI'], startTime: '08:00', endTime: '12:00' };
  const examiner = {
    id: 'ex-time-1',
    name: 'EXAMINADOR HORARIO',
    examRotation: true,
    blockedPeriods: [
      { id: 'bp1', startDate: '2026-12-03', endDate: '2026-12-03', period: 'MORNING' },
    ],
    rotationAvailability: {
      schoolIds: ['school-1'],
      availableDates: [
        { id: 's1', date: '2026-12-01', time: '9:15', createdAt: '2026-11-24T10:00:00Z' },
        { id: 's2', date: '2026-12-03', time: '09:00', createdAt: '2026-11-24T10:00:00Z' },
        { id: 's3', date: '2026-12-03', time: '14:30', createdAt: '2026-11-24T10:00:00Z' },
      ],
    },
  };

  // Matching exact date returns normalized time
  assert.equal(
    resolveExaminerAvailableTimeForSelectedDate({ examiner, date: '2026-12-01', config }),
    '09:15',
  );

  // Morning blocked on 2026-12-03 -> skips 09:00 and picks unblocked 14:30
  assert.equal(
    resolveExaminerAvailableTimeForSelectedDate({ examiner, date: '2026-12-03', config }),
    '14:30',
  );

  // Date not in examiner availableDates -> null (must not steal another date's time)
  assert.equal(
    resolveExaminerAvailableTimeForSelectedDate({ examiner, date: '2026-12-08', config }),
    null,
  );

  // Empty/invalid date -> null
  assert.equal(
    resolveExaminerAvailableTimeForSelectedDate({ examiner, date: '', config }),
    null,
  );
});


