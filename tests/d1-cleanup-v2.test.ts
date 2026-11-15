import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  D1_INITIAL_CHECKSUM,
  D1_VERSION,
  d1Checksum,
  d1Tables,
  initialD1Statements,
  migrateD1,
} from '../db/d1-schema.js';
import { CPF_D1_STATEMENTS, CPF_D1_VERSION, cpfD1Checksum } from '../db/cpf-migration.js';
import {
  CADASTRO_TABS_D1_STATEMENTS,
  CADASTRO_TABS_D1_VERSION,
  cadastroTabsD1Checksum,
} from '../db/cadastro-tabs-migration.js';
import {
  CNH_MODALITY_STATEMENTS,
  CNH_MODALITY_VERSION,
  cnhModalityChecksum,
} from '../db/cnh-exam-modality-migration.js';
import {
  YARDS_INTEREST_STATEMENTS,
  YARDS_INTEREST_VERSION,
  yardsInterestChecksum,
} from '../db/school-yards-interest-migration.js';
import { AUTH_SECURITY_DDL, AUTH_SECURITY_VERSION, authSecurityChecksum } from '../db/auth-security-migration.js';
import {
  CLEANUP_V2_STATEMENTS,
  CLEANUP_V2_VERSION,
  cleanupV2Checksum,
} from '../db/cleanup-v2-migration.js';
import { createD1Db, verifyD1Schema } from '../functions/_d1.js';
import { normalizeBackupPayload } from '../functions/_backup-restore.js';
import { hasCandidateIdentity } from '../functions/_cfc-confirmed.js';
import { translateD1Sql } from '../functions/_d1-sql.js';

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
          const isSelect = /^\s*(SELECT|PRAGMA)\b/i.test(s.sqlText);
          if (isSelect) {
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

function getUserTables(sqlite: DatabaseSync): string[] {
  const rows = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[];
  return rows.map(r => r.name);
}

function getColumns(sqlite: DatabaseSync, table: string): string[] {
  const rows = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  return rows.map(r => r.name);
}

test('initial v1 checksum remains frozen and immutable', async () => {
  const statements = initialD1Statements();
  assert.equal(statements.length, 37);
  assert.equal(await d1Checksum(), D1_INITIAL_CHECKSUM);
  assert.equal(Object.keys(d1Tables).length, 21);
  assert.equal('solicitacoes' in d1Tables, false);
  assert.equal('vagas_banca' in d1Tables, false);
  assert.equal('sessions' in d1Tables, false);
  assert.equal('migracoes_schema' in d1Tables, false);
});

test('cleanup-v2 rebuilds tables cleanly, preserves/coalesces legacy data, and removes legacy tables', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    // 1) Aplicar v1 + 5 migrações exatamente como no banco D1 em produção
    for (const stmt of initialD1Statements()) sqlite.exec(stmt);
    for (const stmt of CPF_D1_STATEMENTS) sqlite.exec(stmt);
    for (const stmt of CADASTRO_TABS_D1_STATEMENTS) sqlite.exec(stmt);
    for (const stmt of CNH_MODALITY_STATEMENTS) sqlite.exec(stmt);
    for (const stmt of YARDS_INTEREST_STATEMENTS) sqlite.exec(stmt);
    sqlite.exec(AUTH_SECURITY_DDL);

    const now = new Date().toISOString();
    const insertMig = sqlite.prepare('INSERT INTO migracoes_d1 (versao, checksum, aplicado_em) VALUES (?, ?, ?)');
    insertMig.run(D1_VERSION, await d1Checksum(), now);
    insertMig.run(CPF_D1_VERSION, await cpfD1Checksum(), now);
    insertMig.run(CADASTRO_TABS_D1_VERSION, await cadastroTabsD1Checksum(), now);
    insertMig.run(CNH_MODALITY_VERSION, await cnhModalityChecksum(), now);
    insertMig.run(YARDS_INTEREST_VERSION, await yardsInterestChecksum(), now);
    insertMig.run(AUTH_SECURITY_VERSION, await authSecurityChecksum(), now);

    assert.equal(getUserTables(sqlite).length, 28);

    // 2) Popular registros variados inclusive em colunas/tabelas legadas
    sqlite.prepare(
      `INSERT INTO configuracoes (id, nome_orgao, preencher_nome_cpf_cnh, zapi_token) VALUES (1, 'DETRAN', 1, 'old-token')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO bancas (id, codigo, data, hora, tipo, status, local_id, location_id) VALUES ('b1', 'B1001', '2026-12-01', '08:00', 'COMMON', 'OPEN', NULL, 'loc-legacy')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO examinadores (id, nome, matricula, categorias, categories, max_vagas_a_padrao, default_max_slots_a, rodizio_provas, disponibilidade_rodizio)
       VALUES ('ex1', 'Examinador 1', '123', NULL, '["A","B"]', NULL, 15, 1, '{"days":["SEG"],"defaultTime":"08:00","examsPerDay":1,"cityIds":["c1"]}')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO instrutores (id, nome, cpf, cpf_hash) VALUES ('inst1', 'Instrutor 1', '11122233344', 'hash123')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO veiculos (id, instrutor_id, tipo, marca, modelo, placa, ano_fabricacao, ano_modelo)
       VALUES ('veh1', 'inst1', 'CARRO', 'Fiat', 'Uno', 'ABC1234', NULL, '2022')`,
    ).run();

    // Dados em módulo já migrado + dados residuais na tabela legada `solicitacoes`
    sqlite.prepare(
      `INSERT INTO solicitacoes_cnhbrasil (id, nome_candidato, tipo_exame, origem, autoescola_id, taxa_paga, taxa_paga_bool, status, modulo)
       VALUES ('cnh-1', 'Maria CNH', 'COMMON', 'INSTRUCTOR', 'CNH_BRASIL', 0, 1, 'WAITING_SCHEDULING', '')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO solicitacoes (id, nome_candidato, tipo_exame, origem, autoescola_id, taxa_paga, taxa_paga_bool, status, modulo)
       VALUES ('cnh-legacy', 'Joao Legado', 'COMMON', 'INSTRUCTOR', NULL, 0, 1, 'WAITING_SCHEDULING', 'CNH_BRASIL')`,
    ).run();

    sqlite.prepare(
      `INSERT INTO solicitacoes_cfc (id, nome_candidato, tipo_exame, origem, autoescola_id, status, examinadores_interessados, quantidades_categoria, modulo)
       VALUES ('cfc-1', 'Residuo Ignorado', 'COMMON', 'SCHOOL', 'cfc-a', 'WAITING_SCHEDULING', '[{"examinerId":"ex1","name":"Examinador 1","registeredAt":"2026-11-15T00:00:00.000Z"}]', '{"A":2,"B":3}', 'CFC')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO solicitacoes (id, nome_candidato, tipo_exame, origem, autoescola_id, status, quantidades_categoria, modulo)
       VALUES ('cfc-legacy', NULL, 'COMMON', 'SCHOOL', 'cfc-b', 'WAITING_SCHEDULING', '{"B":5}', 'CFC')`,
    ).run();

    sqlite.prepare(
      `INSERT INTO solicitacoes_pcd (id, nome_candidato, tipo_exame, origem, autoescola_id, taxa_paga, taxa_paga_bool, tipo_deficiencia, status, modulo)
       VALUES ('pcd-1', 'Ana PCD', 'PCD', 'SCHOOL', 'PCD', 0, 1, 'Auditiva', 'WAITING_SCHEDULING', 'PCD')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO solicitacoes (id, nome_candidato, tipo_exame, origem, autoescola_id, taxa_paga, taxa_paga_bool, tipo_deficiencia, status, modulo)
       VALUES ('pcd-legacy', 'Carlos PCD Legado', 'PCD', 'SCHOOL', 'PCD', 0, 1, 'Fisica', 'WAITING_SCHEDULING', 'PCD')`,
    ).run();

    sqlite.prepare(
      `INSERT INTO vagas_banca (id, autoescola_id, tipo_exame, tipo_solicitacao, data_agendada, hora_agendada, examinador_id, status)
       VALUES ('vb-cfc', 'cfc-a', 'COMMON', 'FIXA', '2026-12-01', '08:00', 'ex1', 'SCHEDULED')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO vagas_banca (id, autoescola_id, tipo_exame, tipo_solicitacao, data_agendada, hora_agendada, examinador_id, status)
       VALUES ('vb-pcd', 'PCD', 'PCD', 'FIXA', '2026-12-01', '09:00', 'ex1', 'SCHEDULED')`,
    ).run();

    // Antes do cleanup-v2, verifyD1Schema já deve aceitar a janela de transição
    const binding = createMockD1Binding(sqlite);
    const db = createD1Db(binding as any);
    await verifyD1Schema(db);

    // 3) Aplicar CLEANUP_V2_STATEMENTS
    for (const stmt of CLEANUP_V2_STATEMENTS) {
      sqlite.exec(stmt);
    }
    insertMig.run(CLEANUP_V2_VERSION, await cleanupV2Checksum(), new Date().toISOString());

    // 4) Verificar 24 tabelas finais e ausência de tabelas legadas
    const tables = getUserTables(sqlite);
    assert.equal(tables.length, 24);
    for (const removed of ['solicitacoes', 'vagas_banca', 'sessions', 'migracoes_schema']) {
      assert.equal(tables.includes(removed), false, `Tabela legada ${removed} deveria ter sido removida`);
    }

    // 5) Verificar colunas de solicitacoes_cfc (somente 24 colunas do domínio CFC)
    const cfcCols = getColumns(sqlite, 'solicitacoes_cfc');
    assert.deepEqual(cfcCols, [
      'id', 'tipo_solicitacao', 'tipo_exame', 'categoria_pretendida', 'origem', 'autoescola_id',
      'status', 'resultado', 'banca_id', 'data_agendada', 'hora_agendada', 'categoria_agendada',
      'examinador_id', 'presenca_confirmada', 'motivo_cancelamento', 'observacao',
      'quantidades_categoria', 'examinadores_interessados', 'modulo', 'cor_linha',
      'criado_em', 'atualizado_em', 'fila_atualizado_em', 'agendado_por',
    ]);

    // 6) Verificar backfill de módulo + preservação de dados
    const cfcRows = sqlite.prepare('SELECT id, autoescola_id, examinadores_interessados, modulo FROM solicitacoes_cfc ORDER BY id').all() as any[];
    assert.equal(cfcRows.length, 2);
    assert.equal(cfcRows[0].id, 'cfc-1');
    assert.match(cfcRows[0].examinadores_interessados, /ex1/);
    assert.equal(cfcRows[1].id, 'cfc-legacy');
    assert.equal(cfcRows[1].autoescola_id, 'cfc-b');

    const cnhCols = getColumns(sqlite, 'solicitacoes_cnhbrasil');
    assert.equal(cnhCols.includes('autoescola_id'), false);
    assert.equal(cnhCols.includes('taxa_paga_bool'), false);
    assert.equal(cnhCols.includes('cpf_hash'), false);
    const cnhRows = sqlite.prepare('SELECT id, nome_candidato, taxa_paga, modulo FROM solicitacoes_cnhbrasil ORDER BY id').all() as any[];
    assert.equal(cnhRows.length, 2);
    assert.equal(cnhRows[0].taxa_paga, 1);
    assert.equal(cnhRows[0].modulo, 'CNH_BRASIL');
    assert.equal(cnhRows[1].id, 'cnh-legacy');
    assert.equal(cnhRows[1].taxa_paga, 1);

    const pcdCols = getColumns(sqlite, 'solicitacoes_pcd');
    assert.equal(pcdCols.includes('autoescola_id'), true);
    assert.equal(pcdCols.includes('taxa_paga_bool'), false);
    assert.equal(pcdCols.includes('cpf_hash'), false);
    const pcdRows = sqlite.prepare('SELECT id, taxa_paga, modulo FROM solicitacoes_pcd ORDER BY id').all() as any[];
    assert.equal(pcdRows.length, 2);
    assert.equal(pcdRows[0].taxa_paga, 1);
    assert.equal(pcdRows[1].id, 'pcd-legacy');

    // 7) Coalesce nas tabelas de cadastro / configuração
    assert.equal(getColumns(sqlite, 'configuracoes').includes('zapi_token'), false);
    assert.equal(getColumns(sqlite, 'configuracoes').includes('preencher_nome_cpf_cnh'), true);
    assert.deepEqual({ ...(sqlite.prepare('SELECT preencher_nome_cpf_cnh FROM configuracoes WHERE id = 1').get() as object) }, { preencher_nome_cpf_cnh: 1 });

    assert.equal(getColumns(sqlite, 'bancas').includes('location_id'), false);
    assert.deepEqual({ ...(sqlite.prepare('SELECT local_id FROM bancas WHERE id = ?').get('b1') as object) }, { local_id: 'loc-legacy' });

    const exCols = getColumns(sqlite, 'examinadores');
    assert.equal(exCols.includes('categories'), false);
    assert.equal(exCols.includes('default_max_slots_a'), false);
    assert.deepEqual({ ...(sqlite.prepare('SELECT categorias, max_vagas_a_padrao FROM examinadores WHERE id = ?').get('ex1') as object) }, {
      categorias: '["A","B"]',
      max_vagas_a_padrao: 15,
    });

    assert.equal(getColumns(sqlite, 'veiculos').includes('ano_modelo'), false);
    assert.deepEqual({ ...(sqlite.prepare('SELECT ano_fabricacao FROM veiculos WHERE id = ?').get('veh1') as object) }, { ano_fabricacao: '2022' });

    assert.equal(getColumns(sqlite, 'instrutores').includes('cpf_hash'), false);

    // 8) Triggers recriados em vagas_cfc e backfill de vagas_banca
    const vagasCfc = sqlite.prepare('SELECT id FROM vagas_cfc').all() as { id: string }[];
    const vagasPcd = sqlite.prepare('SELECT id FROM vagas_pcd').all() as { id: string }[];
    assert.deepEqual(vagasCfc.map(v => v.id), ['vb-cfc']);
    assert.deepEqual(vagasPcd.map(v => v.id), ['vb-pcd']);
    assert.throws(() => {
      sqlite.prepare(
        `INSERT INTO vagas_cfc (id, autoescola_id, tipo_exame, tipo_solicitacao, data_agendada, hora_agendada, examinador_id, status)
         VALUES ('vb-conflict', 'cfc-b', 'COMMON', 'FIXA', '2026-12-01', '08:00', 'ex1', 'SCHEDULED')`,
      ).run();
    }, /D1_EXAMINER_CONFLICT/);

    // 9) verifyD1Schema pós-cleanup passa com checksum válido e falha se alterado
    const dbAfter = createD1Db(binding as any);
    await verifyD1Schema(dbAfter);

    sqlite.prepare('UPDATE migracoes_d1 SET checksum = ? WHERE versao = ?').run('bad-checksum', CLEANUP_V2_VERSION);
    const dbBad = createD1Db(createMockD1Binding(sqlite) as any);
    await assert.rejects(() => verifyD1Schema(dbBad), /incompatível/);
  } finally {
    sqlite.close();
  }
});

test('migrateD1 executes cleanly from empty database through cleanup-v2 (idempotent)', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    const binding = createMockD1Binding(sqlite);
    await migrateD1(binding as any);
    await migrateD1(binding as any); // segunda execução deve ser idempotente
    assert.equal(getUserTables(sqlite).length, 24);
    assert.equal(getColumns(sqlite, 'solicitacoes_cfc').length, 24);
    const mig = sqlite.prepare('SELECT versao FROM migracoes_d1 ORDER BY versao').all() as { versao: string }[];
    assert.equal(mig.some(m => m.versao === CLEANUP_V2_VERSION), true);
  } finally {
    sqlite.close();
  }
});

test('backup restore normalization, translateD1Sql, and hasCandidateIdentity align with cleaned schema', () => {
  const normalized = normalizeBackupPayload({
    solicitacoes: [{ id: 'old-1', nome_candidato: 'Legacy' }],
    vagas_banca: [{ id: 'old-slot-1', autoescola_id: 's1' }],
    solicitacoes_cfc: [{
      id: 'cfc-1',
      nome_candidato: 'Lixo',
      cpf: '000',
      autoescola_id: 's1',
      tipo_exame: 'COMMON',
      origem: 'SCHOOL',
      status: 'WAITING_SCHEDULING',
    }],
    solicitacoes_cnhbrasil: [{
      id: 'cnh-1',
      autoescola_id: 'CNH_BRASIL',
      taxa_paga_bool: true,
      nome_candidato: 'Maria',
      tipo_exame: 'COMMON',
      origem: 'INSTRUCTOR',
      status: 'WAITING_SCHEDULING',
    }],
  });

  assert.equal((normalized as any).solicitacoes, undefined);
  assert.equal((normalized as any).vagas_banca, undefined);
  assert.equal(normalized.solicitacoes_cfc.length, 1);
  assert.equal(normalized.solicitacoes_cfc[0].nome_candidato, undefined);
  assert.equal(normalized.solicitacoes_cfc[0].cpf, undefined);
  assert.equal(normalized.solicitacoes_cnhbrasil[0].autoescola_id, undefined);
  assert.equal(normalized.solicitacoes_cnhbrasil[0].taxa_paga, true);

  assert.throws(() => translateD1Sql('INSERT INTO "solicitacoes" ("id") VALUES ($1)', ['x']), /Tabela D1 desconhecida/);
  const ok = translateD1Sql('INSERT INTO "solicitacoes_cfc" ("id", "status") VALUES ($1, $2)', ['cfc-2', 'WAITING_SCHEDULING']);
  assert.match(ok.sql, /INSERT INTO "solicitacoes_cfc"/);

  assert.equal(hasCandidateIdentity({ id: 'cfc-confirmed', status: 'SCHEDULED', attendanceConfirmed: true }), false);
  assert.equal(hasCandidateIdentity({ id: 'cnh-1', studentName: 'Maria' }), true);
});
