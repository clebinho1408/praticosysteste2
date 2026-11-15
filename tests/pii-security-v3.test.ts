import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ENCRYPTED_PREFIX,
  computeCpfHmac,
  decryptField,
  decryptInstructorPii,
  decryptRequestPii,
  encryptField,
  encryptInstructorPii,
  encryptRequestPii,
  maskAuditDetails,
  maskCpf,
} from '../db/pii-crypto.js';
import { migrateD1 } from '../db/d1-schema.js';
import { PII_V3_VERSION } from '../db/pii-v3-migration.js';
import { createD1Db, verifyD1Schema } from '../functions/_d1.js';
import { restoreBackup } from '../functions/_backup-restore.js';
import { buildEncryptUpdateStatements } from '../scripts/apply-d1-pii-v3.js';

const TEST_ENV = {
  DATA_ENCRYPTION_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
  CPF_HMAC_KEY: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
};

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
      return (stmt.get(...(params as any[])) as T | undefined) ?? null;
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

test('AES-256-GCM field encryption uses random IV, stays idempotent, and handles missing keys safely', async () => {
  const plain = '123.456.789-01';
  const enc1 = await encryptField(plain, TEST_ENV);
  const enc2 = await encryptField(plain, TEST_ENV);

  assert.equal(enc1.startsWith(ENCRYPTED_PREFIX), true);
  assert.equal(enc2.startsWith(ENCRYPTED_PREFIX), true);
  assert.notEqual(enc1, enc2);
  assert.equal(await encryptField(enc1, TEST_ENV), enc1);
  assert.equal(await decryptField(enc1, TEST_ENV), plain);
  assert.equal(await decryptField(plain, TEST_ENV), plain);
  assert.equal(await decryptField(null, TEST_ENV), null);

  // Sem chave configurada, leitura de plaintext continua ok e gravação mantém plaintext (rollout sem quebra)
  assert.equal(await encryptField(plain, {}), plain);
  assert.equal(await decryptField(plain, {}), plain);
  await assert.rejects(() => decryptField(enc1, {}), /DATA_ENCRYPTION_KEY/);
});

test('computeCpfHmac produces deterministic blind index across formatting and respects dedicated HMAC key', async () => {
  const hFormatted = await computeCpfHmac('123.456.789-01', TEST_ENV);
  const hDigits = await computeCpfHmac('12345678901', TEST_ENV);
  const hDerived = await computeCpfHmac('12345678901', { DATA_ENCRYPTION_KEY: TEST_ENV.DATA_ENCRYPTION_KEY });

  assert.equal(hFormatted, hDigits);
  assert.equal(hFormatted?.length, 64);
  assert.notEqual(hFormatted, hDerived);
  assert.equal(await computeCpfHmac('', TEST_ENV), null);
});

test('maskCpf and maskAuditDetails redact sensitive digits consistently', () => {
  assert.equal(maskCpf('12345678901'), '***.456.789-**');
  assert.equal(maskCpf('123.456.789-01'), '***.456.789-**');
  assert.equal(maskCpf('***.456.789-**'), '***.456.789-**');
  assert.equal(maskCpf(`${ENCRYPTED_PREFIX}abc:def`), '***.***.***-**');

  const masked = maskAuditDetails({ cpf: '12345678901', name: 'Maria' });
  assert.deepEqual(masked, { cpf: '***.456.789-**', name: 'Maria' });
});

test('request and instructor PII round-trip encrypts sensitive columns and strips cpfHmac on decrypt', async () => {
  const reqSaved = await encryptRequestPii({
    id: 'r1',
    studentName: 'Maria Silva',
    cpf: '12345678901',
    phone: '(11) 99999-8888',
    email: 'maria@example.com',
    address: 'Rua A, 10',
  }, TEST_ENV);

  assert.ok((reqSaved as any).cpfHmac);
  assert.ok(reqSaved.cpf.startsWith(ENCRYPTED_PREFIX));
  assert.ok(reqSaved.phone.startsWith(ENCRYPTED_PREFIX));
  assert.ok(reqSaved.email.startsWith(ENCRYPTED_PREFIX));
  assert.ok(reqSaved.address.startsWith(ENCRYPTED_PREFIX));

  const reqRead = await decryptRequestPii(reqSaved, TEST_ENV);
  assert.equal((reqRead as any).cpfHmac, undefined);
  assert.equal(reqRead.cpf, '12345678901');
  assert.equal(reqRead.phone, '(11) 99999-8888');
  assert.equal(reqRead.email, 'maria@example.com');
  assert.equal(reqRead.address, 'Rua A, 10');

  const instSaved = await encryptInstructorPii({ id: 'i1', name: 'Joao', cpf: '98765432100', phone: '11988887777' }, TEST_ENV);
  assert.ok((instSaved as any).cpfHmac);
  assert.ok(instSaved.cpf.startsWith(ENCRYPTED_PREFIX));
  const instRead = await decryptInstructorPii(instSaved, TEST_ENV);
  assert.equal((instRead as any).cpfHmac, undefined);
  assert.equal(instRead.cpf, '98765432100');
  assert.equal(instRead.phone, '11988887777');
});

test('migrateD1 applies v3 cpf_hmac columns/indexes, retroactive encryption SQL works idempotently, and restoreBackup encrypts plaintext payloads', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    const binding = createMockD1Binding(sqlite);
    await migrateD1(binding as any);
    await migrateD1(binding as any);

    const migs = sqlite.prepare('SELECT versao FROM migracoes_d1').all() as { versao: string }[];
    assert.equal(migs.some(m => m.versao === PII_V3_VERSION), true);

    for (const table of ['solicitacoes_cnhbrasil', 'solicitacoes_pcd', 'instrutores']) {
      const cols = (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(c => c.name);
      assert.equal(cols.includes('cpf_hmac'), true, `${table} deveria conter cpf_hmac`);
    }

    // Simular registros antigos em texto puro antes da criptografia
    sqlite.prepare(
      `INSERT INTO solicitacoes_cnhbrasil (id, nome_candidato, cpf, telefone, email, endereco, tipo_exame, origem, status, modulo)
       VALUES ('cnh-old', 'Ana', '12345678901', '11911112222', 'ana@example.com', 'Rua B', 'COMMON', 'INSTRUCTOR', 'WAITING_SCHEDULING', 'CNH_BRASIL')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO instrutores (id, nome, cpf, telefone) VALUES ('inst-old', 'Carlos', '98765432100', '11933334444')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO logs_auditoria (id, acao, entidade, entidade_id, detalhes)
       VALUES ('log-old', 'Foi cadastrado', 'CNH_BRASIL_CANDIDATO', 'cnh-old', '{"cpf":"12345678901","name":"Ana"}')`,
    ).run();

    const dump = {
      solicitacoes_cnhbrasil: sqlite.prepare('SELECT id, cpf, cpf_hmac, telefone, email, endereco FROM solicitacoes_cnhbrasil').all() as any[],
      solicitacoes_pcd: sqlite.prepare('SELECT id, cpf, cpf_hmac, telefone, email, endereco FROM solicitacoes_pcd').all() as any[],
      instrutores: sqlite.prepare('SELECT id, cpf, cpf_hmac, telefone FROM instrutores').all() as any[],
      logs_auditoria: sqlite.prepare('SELECT id, detalhes FROM logs_auditoria').all() as any[],
    };

    const { statements, counts } = await buildEncryptUpdateStatements(dump, TEST_ENV);
    assert.equal(counts.solicitacoes_cnhbrasil, 1);
    assert.equal(counts.instrutores, 1);
    assert.equal(counts.logs_auditoria, 1);
    for (const s of statements) sqlite.exec(s);

    const updatedCnh = sqlite.prepare('SELECT cpf, cpf_hmac, telefone, email, endereco FROM solicitacoes_cnhbrasil WHERE id = ?').get('cnh-old') as any;
    assert.equal(updatedCnh.cpf.startsWith(ENCRYPTED_PREFIX), true);
    assert.equal(await decryptField(updatedCnh.cpf, TEST_ENV), '12345678901');
    assert.equal(updatedCnh.cpf_hmac, await computeCpfHmac('12345678901', TEST_ENV));

    const updatedLog = sqlite.prepare('SELECT detalhes FROM logs_auditoria WHERE id = ?').get('log-old') as any;
    assert.deepEqual(JSON.parse(updatedLog.detalhes), { cpf: '***.456.789-**', name: 'Ana' });

    // Idempotência: segunda execução do buildEncryptUpdateStatements não gera UPDATEs
    const secondRun = await buildEncryptUpdateStatements({
      solicitacoes_cnhbrasil: sqlite.prepare('SELECT id, cpf, cpf_hmac, telefone, email, endereco FROM solicitacoes_cnhbrasil').all() as any[],
      solicitacoes_pcd: [],
      instrutores: sqlite.prepare('SELECT id, cpf, cpf_hmac, telefone FROM instrutores').all() as any[],
      logs_auditoria: sqlite.prepare('SELECT id, detalhes FROM logs_auditoria').all() as any[],
    }, TEST_ENV);
    assert.equal(secondRun.statements.length, 0);

    // restoreBackup com payload antigo em texto puro criptografa automaticamente
    const db = createD1Db(createMockD1Binding(sqlite) as any);
    await verifyD1Schema(db);
    await restoreBackup(db, {
      solicitacoes_pcd: [{
        id: 'pcd-restored',
        nome_candidato: 'Paulo',
        cpf: '11122233344',
        telefone: '11955556666',
        tipo_exame: 'PCD',
        origem: 'SCHOOL',
        autoescola_id: 'PCD',
        status: 'WAITING_SCHEDULING',
      }],
    }, { env: TEST_ENV });

    const restoredRow = sqlite.prepare('SELECT cpf, cpf_hmac, telefone FROM solicitacoes_pcd WHERE id = ?').get('pcd-restored') as any;
    assert.equal(restoredRow.cpf.startsWith(ENCRYPTED_PREFIX), true);
    assert.equal(await decryptField(restoredRow.cpf, TEST_ENV), '11122233344');
    assert.equal(restoredRow.cpf_hmac, await computeCpfHmac('11122233344', TEST_ENV));
    assert.equal(await decryptField(restoredRow.telefone, TEST_ENV), '11955556666');

    // Checksum adulterado em migracoes_d1 deve falhar
    sqlite.prepare('UPDATE migracoes_d1 SET checksum = ? WHERE versao = ?').run('bad', PII_V3_VERSION);
    await assert.rejects(() => verifyD1Schema(createD1Db(createMockD1Binding(sqlite) as any)), /incompatível/);
  } finally {
    sqlite.close();
  }
});
