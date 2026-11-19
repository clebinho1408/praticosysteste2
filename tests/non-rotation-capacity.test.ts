import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateD1 } from '../db/d1-schema.js';
import { NON_ROTATION_V4_VERSION } from '../db/non-rotation-capacity-v4-migration.js';
import { onRequest as scheduleSlotsOnRequest } from '../functions/api/schedule-slots.js';

function createMockD1Binding(sqlite: DatabaseSync) {
  const wrap = (sqlText: string, params: unknown[] = []) => ({
    sqlText,
    params,
    bind(...nextParams: unknown[]) {
      return wrap(sqlText, nextParams);
    },
    async all<T = any>() {
      const stmt = sqlite.prepare(sqlText);
      const rows = stmt.all(...(params as any[])) as T[];
      return { results: rows, success: true, meta: { changes: 0 } };
    },
    async first<T = any>() {
      const stmt = sqlite.prepare(sqlText);
      const row = (stmt.get(...(params as any[])) as T | undefined) ?? null;
      return row;
    },
    async run() {
      const stmt = sqlite.prepare(sqlText);
      const info = stmt.run(...(params as any[]));
      return { results: [], success: true, meta: { changes: Number(info.changes ?? 0) } };
    },
  });

  return {
    prepare(sqlText: string) {
      return wrap(sqlText);
    },
    async batch(statements: Array<ReturnType<typeof wrap>>) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) {
          const returnsRows = /^\s*(SELECT|PRAGMA)\b/i.test(s.sqlText) || /\bRETURNING\b/i.test(s.sqlText);
          if (returnsRows) {
            out.push(await s.all());
          } else {
            const stmt = sqlite.prepare(s.sqlText);
            const info = stmt.run(...(s.params as any[]));
            out.push({ results: [], success: true, meta: { changes: Number(info.changes ?? 0) } });
          }
        }
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

async function seedTestDb(sqlite: DatabaseSync) {
  const binding = createMockD1Binding(sqlite);
  await migrateD1(binding as any);

  sqlite.prepare(`INSERT INTO cidades (id, nome) VALUES ('c1', 'TIJUCAS')`).run();
  sqlite.prepare(`
    INSERT INTO examinadores (id, nome, matricula, categorias, rodizio_provas, disponibilidade_rodizio)
    VALUES ('ex-1', 'Examinador 1', '1001', '["A","B"]', 1, '{"days":["QUA"],"defaultTime":"08:00","examsPerDay":1,"cityIds":["c1"]}')
  `).run();

  const fixedSchedule = (slots: Array<{ day: string; time: string; examiner: string }>) => JSON.stringify({
    active: true,
    frequency: '1_WEEK',
    days: ['QUA'],
    slots,
  });

  sqlite.prepare(`
    INSERT INTO autoescolas (id, nome, cidade, rodizio_provas, banca_principal, banca_provisoria)
    VALUES
      ('sch-1', 'QUINZEN TIJUCAS', 'TIJUCAS', 0, ?, '{"active":false,"days":[],"slots":[]}'),
      ('sch-2', 'ESTRELA DO MAR', 'TIJUCAS', 0, ?, '{"active":false,"days":[],"slots":[]}'),
      ('sch-3', 'TIJUCAS', 'TIJUCAS', 0, ?, '{"active":false,"days":[],"slots":[]}'),
      ('sch-rot', 'ESCOLA RODIZIO', 'TIJUCAS', 1, ?, '{"active":false,"days":[],"slots":[]}')
  `).run(
    fixedSchedule([{ day: 'QUA', time: '08:00', examiner: 'ex-1' }]),
    fixedSchedule([{ day: 'QUA', time: '09:00', examiner: 'ex-1' }]),
    fixedSchedule([{ day: 'QUA', time: '10:00', examiner: 'ex-1' }, { day: 'QUA', time: '11:00', examiner: 'ex-1' }]),
    fixedSchedule([{ day: 'QUA', time: '08:00', examiner: 'ex-1' }]),
  );

  return binding;
}

async function callAutoFixed(binding: any, schoolId: string, date: string, slots: Array<{ examinerId: string; scheduledTime: string }>) {
  const req = new Request('http://localhost/api/schedule-slots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ automaticFixed: { schoolId, date, slots } }),
  });
  return scheduleSlotsOnRequest({
    request: req,
    env: { DB_PROVIDER: 'd1', DB: binding } as any,
    data: { sessionUserRole: 'ADMIN' },
  } as any);
}

test('non-rotation schools bypass examiner examsPerDay limit in D1 API & triggers while rotation schools still enforce it', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    const binding = await seedTestDb(sqlite);
    const migs = sqlite.prepare('SELECT versao FROM migracoes_d1').all() as { versao: string }[];
    assert.equal(migs.some(m => m.versao === NON_ROTATION_V4_VERSION), true);

    const r1 = await callAutoFixed(binding, 'sch-1', '2026-11-25', [{ examinerId: 'ex-1', scheduledTime: '08:00' }]);
    assert.equal(r1.status, 200);

    const r2 = await callAutoFixed(binding, 'sch-2', '2026-11-25', [{ examinerId: 'ex-1', scheduledTime: '09:00' }]);
    assert.equal(r2.status, 200);

    const r3 = await callAutoFixed(binding, 'sch-3', '2026-11-25', [
      { examinerId: 'ex-1', scheduledTime: '10:00' },
      { examinerId: 'ex-1', scheduledTime: '11:00' },
    ]);
    assert.equal(r3.status, 200);
    const created3 = await r3.json() as any[];
    assert.equal(created3.length, 2);

    // Rotation school on another day respects examsPerDay = 1
    const rRot1 = await callAutoFixed(binding, 'sch-rot', '2026-12-02', [{ examinerId: 'ex-1', scheduledTime: '08:00' }]);
    assert.equal(rRot1.status, 200);

    // Add a second rotation school sharing the same examiner on 2026-12-02 at a different time via manual slot -> blocked by D1_EXAMINER_CAPACITY
    sqlite.prepare(`
      INSERT INTO autoescolas (id, nome, cidade, rodizio_provas)
      VALUES ('sch-rot-2', 'ESCOLA RODIZIO 2', 'TIJUCAS', 1)
    `).run();
    assert.throws(() => {
      sqlite.prepare(`
        INSERT INTO vagas_cfc (id, autoescola_id, tipo_exame, tipo_solicitacao, data_agendada, hora_agendada, examinador_id, status)
        VALUES ('cap-fail', 'sch-rot-2', 'COMMON', 'FIXA', '2026-12-02', '14:00', 'ex-1', 'SCHEDULED')
      `).run();
    }, /D1_EXAMINER_CAPACITY/);

    // Same date+time conflict still throws D1_EXAMINER_CONFLICT even on non-rotation schools
    assert.throws(() => {
      sqlite.prepare(`
        INSERT INTO vagas_cfc (id, autoescola_id, tipo_exame, tipo_solicitacao, data_agendada, hora_agendada, examinador_id, status)
        VALUES ('time-fail', 'sch-2', 'COMMON', 'FIXA', '2026-11-25', '08:00', 'ex-1', 'SCHEDULED')
      `).run();
    }, /D1_EXAMINER_CONFLICT/);
  } finally {
    sqlite.close();
  }
});

test('schedule-slots self-heals stale pre-v4 D1 capacity trigger on non-rotation school insert', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    const binding = await seedTestDb(sqlite);
    // Simulate a live D1 database that still has the old pre-v4 trigger without rodizio_provas = 1 guard
    sqlite.exec(`
      DROP TRIGGER IF EXISTS vagas_cfc_guard_insert;
      CREATE TRIGGER vagas_cfc_guard_insert
        BEFORE INSERT ON vagas_cfc
        WHEN true AND NEW.status != 'CANCELLED' AND NEW.examinador_id IS NOT NULL
          AND NEW.data_agendada IS NOT NULL AND NEW.hora_agendada IS NOT NULL
        BEGIN
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM vagas_cfc WHERE examinador_id = NEW.examinador_id
            AND data_agendada = NEW.data_agendada AND hora_agendada = NEW.hora_agendada
            AND status != 'CANCELLED' AND id != NEW.id
          ) THEN RAISE(ABORT, 'D1_EXAMINER_CONFLICT') END;
          SELECT CASE WHEN (
            SELECT count(*) FROM vagas_cfc WHERE examinador_id = NEW.examinador_id
            AND data_agendada = NEW.data_agendada AND status != 'CANCELLED' AND id != NEW.id
          ) >= (
            SELECT json_extract(disponibilidade_rodizio, '$.examsPerDay')
            FROM examinadores WHERE id = NEW.examinador_id AND rodizio_provas = 1
          ) THEN RAISE(ABORT, 'D1_EXAMINER_CAPACITY') END;
        END;
    `);

    const r1 = await callAutoFixed(binding, 'sch-1', '2026-11-25', [{ examinerId: 'ex-1', scheduledTime: '08:00' }]);
    assert.equal(r1.status, 200);

    // Without self-healing, sch-2 would fail with D1_EXAMINER_CAPACITY
    const r2 = await callAutoFixed(binding, 'sch-2', '2026-11-25', [{ examinerId: 'ex-1', scheduledTime: '09:00' }]);
    assert.equal(r2.status, 200);
  } finally {
    sqlite.close();
  }
});
