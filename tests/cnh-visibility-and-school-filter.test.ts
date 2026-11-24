import test from 'node:test';
import assert from 'node:assert/strict';
import * as schema from '../db/schema.js';
import { accessPolicy, AccessDenied } from '../functions/_access-policy.js';
import { activeSchoolScale, matchesSchoolScale } from '../functions/_school-schedule.js';

function createFakeDb(fixtures: Record<string, any[]>) {
  return {
    select() {
      return {
        from(table: any) {
          if (table === schema.examSchedules) return Promise.resolve(fixtures.schedules ?? []);
          if (table === schema.instructors) return Promise.resolve(fixtures.instructors ?? []);
          if (table === schema.drivingSchools) return Promise.resolve(fixtures.schools ?? []);
          if (table === schema.examiners) return Promise.resolve(fixtures.examiners ?? []);
          if (table === schema.cnhbrasilRequests) return Promise.resolve(fixtures.cnh ?? []);
          if (table === schema.cfcRequests) return Promise.resolve(fixtures.cfc ?? []);
          if (table === schema.pcdRequests) return Promise.resolve(fixtures.pcd ?? []);
          if (table === schema.cfcScheduleSlots) return Promise.resolve(fixtures.cfcSlots ?? []);
          if (table === schema.pcdScheduleSlots) return Promise.resolve(fixtures.pcdSlots ?? []);
          if (table === schema.bancaResults) return Promise.resolve([]);
          return Promise.resolve([]);
        },
      };
    },
  };
}

test('Admin, Supervisor, and Operator with CNH access see identical candidate counts in Candidatos even with allowedLocationIds', async () => {
  const schedules = [
    { id: 'banca-loc-a', type: 'COMMON', status: 'OPEN', date: '2026-11-20', time: '08:00', locationId: 'loc-a' },
    { id: 'banca-loc-b', type: 'COMMON', status: 'CONCLUDED', date: '2026-11-10', time: '09:00', locationId: 'loc-b' },
    { id: 'banca-no-loc', type: 'COMMON', status: 'CONCLUDED', date: '2026-10-15', time: '10:00', locationId: null },
  ];
  const cnh = [
    { id: 'r1', modulo: 'CNH_BRASIL', examType: 'COMMON', status: 'IN_ANALYSIS', scheduleId: null },
    // Retorno de INAPTO em banca de outro local mantém scheduleId antigo
    { id: 'r2', modulo: 'CNH_BRASIL', examType: 'COMMON', status: 'WAITING_SCHEDULING', scheduleId: 'banca-loc-b' },
    { id: 'r3', modulo: 'CNH_BRASIL', examType: 'COMMON', status: 'WAITING_SCHEDULING', scheduleId: null },
    // Agendado em banca de outro local sem scheduledDate/Time gravados no request
    { id: 'r4', modulo: 'CNH_BRASIL', examType: 'COMMON', status: 'SCHEDULED', scheduleId: 'banca-loc-b', scheduledDate: null, scheduledTime: null },
    { id: 'r5', modulo: 'CNH_BRASIL', examType: 'COMMON', status: 'WAITING_RESULT', scheduleId: 'banca-no-loc' },
    { id: 'r6', modulo: 'CNH_BRASIL', examType: 'COMMON', status: 'DONE', scheduleId: 'banca-deleted' },
  ];

  const db = createFakeDb({ schedules, cnh });

  const admin = { id: 'u-admin', role: 'ADMIN', allowedModules: ['cnh', 'cfc', 'pcd'], allowedLocationIds: [] };
  const supervisor = { id: 'u-sup', role: 'SUPERVISOR', allowedModules: ['cnh'], allowedLocationIds: ['loc-a'] };
  const operator = { id: 'u-op', role: 'OPERATOR', allowedModules: ['cnh'], allowedLocationIds: ['loc-a'] };
  const noCnhSup = { id: 'u-nocnh', role: 'SUPERVISOR', allowedModules: ['cfc'], allowedLocationIds: ['loc-a'] };

  const adminPolicy = await accessPolicy(db, schema, admin);
  const supPolicy = await accessPolicy(db, schema, supervisor);
  const opPolicy = await accessPolicy(db, schema, operator);
  const noCnhPolicy = await accessPolicy(db, schema, noCnhSup);

  const adminReqs = await adminPolicy.project(cnh, 'requests');
  const supReqs = await supPolicy.project(cnh, 'requests');
  const opReqs = await opPolicy.project(cnh, 'requests');
  const noCnhReqs = await noCnhPolicy.project(cnh, 'requests');

  assert.equal(adminReqs.length, 6);
  assert.equal(supReqs.length, 6);
  assert.equal(opReqs.length, 6);
  assert.equal(noCnhReqs.length, 0);

  // scheduledDate / scheduledTime preenchidos via banca mesmo quando banca está oculta em /api/schedules
  const r4ForSup = supReqs.find((r: any) => r.id === 'r4');
  assert.equal(r4ForSup.scheduledDate, '2026-11-10');
  assert.equal(r4ForSup.scheduledTime, '09:00');

  // Bancas (/api/schedules) continuam restritas por allowedLocationIds
  const adminScheds = await adminPolicy.project(schedules, 'schedules');
  const supScheds = await supPolicy.project(schedules, 'schedules');
  const opScheds = await opPolicy.project(schedules, 'schedules');
  assert.equal(adminScheds.length, 3);
  assert.deepEqual(supScheds.map((s: any) => s.id), ['banca-loc-a']);
  assert.deepEqual(opScheds.map((s: any) => s.id), ['banca-loc-a']);

  // Supervisor pode editar candidato WAITING_SCHEDULING com scheduleId legado e agendar em banca permitida
  await supPolicy.authorize('requests', 'PUT', { id: 'r2', phone: '11999999999' }, {});
  await supPolicy.authorize('requests', 'PUT', { id: 'r2', scheduleId: 'banca-loc-a', status: 'SCHEDULED' }, {});

  // Supervisor NÃO pode agendar ou remover candidato em banca de outro local
  await assert.rejects(
    () => supPolicy.authorize('requests', 'PUT', { id: 'r2', scheduleId: 'banca-loc-b', status: 'SCHEDULED' }, {}),
    AccessDenied,
  );
  await assert.rejects(
    () => supPolicy.authorize('requests', 'PUT', { id: 'r4', scheduleId: null, status: 'WAITING_SCHEDULING' }, {}),
    AccessDenied,
  );
});

test('Autoescolas scale helper classifies and filters Principal, Provisória, and inactive schedules accurately', () => {
  const onlyMain = {
    mainSchedule: { active: true },
    provisionalSchedule: { active: false },
  };
  const provisionalActive = {
    mainSchedule: { active: false },
    provisionalSchedule: { active: true },
  };
  const bothFlaggedTakesProvisional = {
    mainSchedule: { active: true },
    provisionalSchedule: { active: true },
  };
  const inactive = {
    mainSchedule: { active: false },
    provisionalSchedule: { active: false },
  };

  assert.equal(activeSchoolScale(onlyMain), 'MAIN');
  assert.equal(activeSchoolScale(provisionalActive), 'PROVISIONAL');
  assert.equal(activeSchoolScale(bothFlaggedTakesProvisional), 'PROVISIONAL');
  assert.equal(activeSchoolScale(inactive), null);

  assert.equal(matchesSchoolScale(onlyMain, ''), true);
  assert.equal(matchesSchoolScale(onlyMain, 'MAIN'), true);
  assert.equal(matchesSchoolScale(onlyMain, 'PROVISIONAL'), false);

  assert.equal(matchesSchoolScale(provisionalActive, ''), true);
  assert.equal(matchesSchoolScale(provisionalActive, 'MAIN'), false);
  assert.equal(matchesSchoolScale(provisionalActive, 'PROVISIONAL'), true);

  assert.equal(matchesSchoolScale(inactive, ''), true);
  assert.equal(matchesSchoolScale(inactive, 'MAIN'), false);
  assert.equal(matchesSchoolScale(inactive, 'PROVISIONAL'), false);
});

test('EXAMINER in rotation sees rotationConfig only for assigned examRotation schools without leaking rotationEntries', async () => {
  const schools = [
    {
      id: 'sch-rot-1',
      name: 'CFC RODIZIO 1',
      city: 'ITAPEMA',
      examRotation: true,
      mainSchedule: {
        active: true,
        rotationConfig: { days: ['SEG', 'QUA'], startTime: '08:00', endTime: '12:00' },
        rotationEntries: [{ id: 'e1', date: '2026-12-07', time: '09:00', examiner: 'ex-other' }],
      },
    },
    {
      id: 'sch-rot-2',
      name: 'CFC RODIZIO 2',
      city: 'TIJUCAS',
      examRotation: true,
      mainSchedule: {
        active: true,
        rotationConfig: { days: ['SEX'], startTime: '14:00', endTime: '18:00' },
        rotationEntries: [],
      },
    },
  ];
  const examiners = [
    {
      id: 'ex-1',
      name: 'EXAMINADOR UM',
      examRotation: true,
      canExamCommon: true,
      categories: ['A', 'B'],
      rotationAvailability: { schoolIds: ['sch-rot-1'], availableDates: [] },
    },
  ];
  const cfc = [
    {
      id: 'req-extra',
      modulo: 'CFC',
      examType: 'COMMON',
      schoolId: 'sch-rot-2',
      intendedCategory: 'B',
      status: 'WAITING_SCHEDULING',
      attendanceConfirmed: false,
    },
  ];
  const db = createFakeDb({ schools, examiners, cfc });
  const exPolicy = await accessPolicy(db, schema, { id: 'u-ex', role: 'EXAMINER', examinerId: 'ex-1' });
  const visibleSchools = await exPolicy.project(schools, 'schools');

  const sch1 = visibleSchools.find((s: any) => s.id === 'sch-rot-1');
  const sch2 = visibleSchools.find((s: any) => s.id === 'sch-rot-2');
  assert.ok(sch1);
  assert.equal(sch1.examRotation, true);
  assert.deepEqual(sch1.mainSchedule, {
    active: true,
    rotationConfig: { days: ['SEG', 'QUA'], startTime: '08:00', endTime: '12:00' },
  });
  assert.equal(Object.hasOwn(sch1.mainSchedule, 'rotationEntries'), false);

  // sch-rot-2 aparece apenas pelo pedido extra na fila, sem expor mainSchedule/rotationConfig
  assert.ok(sch2);
  assert.deepEqual(sch2, { id: 'sch-rot-2', name: 'CFC RODIZIO 2', city: 'TIJUCAS' });
});
