import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';
import type { D1Database } from './d1-types.js';
import { migrateCpfD1 } from './cpf-migration.js';
import { migrateCadastroTabsD1 } from './cadastro-tabs-migration.js';
import { migrateCnhModalityD1 } from './cnh-exam-modality-migration.js';
import { migrateYardsInterestD1 } from './school-yards-interest-migration.js';
import { migrateAuthSecurityD1 } from './auth-security-migration.js';
import { migrateCleanupV2D1 } from './cleanup-v2-migration.js';
import { migratePiiV3D1 } from './pii-v3-migration.js';
import { INITIAL_D1_V1_STATEMENTS } from './d1-v1-baseline.js';

export const D1_NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";
export const D1_VERSION = 'd1_schema_v1';
// Freeze this released baseline. A changed generator must become a reviewed
// NEW migration; silently rewriting the applied checksum is never permitted.
export const D1_INITIAL_CHECKSUM = 'cccc65180e383fdeabad6b239c1a2cc9f51d116b42953cd287e8224372ad3d11';
export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export type D1Column = { name: string; kind: string; required: boolean; primary: boolean; unique: boolean; defaultSql: string };
const dialect = new PgDialect();

// The existing schema remains the source of API property names and codecs.
// This is the initial SQLite migration; the applied checksum prevents silently
// changing a migration that has already run.
export const d1Tables: Record<string, D1Column[]> = Object.fromEntries(
  Object.values(schema).map(table => {
    const config = getTableConfig(table);
    return [config.name, Object.values(getTableColumns(table)).map((column): D1Column => {
      const kind = column.dataType === 'json' ? 'json' : column.dataType === 'boolean' ? 'boolean'
        : column.dataType === 'date' ? 'timestamp' : column.dataType;
      let defaultSql = 'NULL';
      if (column.default !== undefined) {
        if (column.default && typeof column.default === 'object' && 'queryChunks' in column.default) {
          defaultSql = dialect.sqlToQuery(column.default as any).sql.replace(/now\(\)/gi, D1_NOW);
        } else if (kind === 'json') defaultSql = `'${JSON.stringify(column.default).replaceAll("'", "''")}'`;
        else if (typeof column.default === 'string') defaultSql = `'${column.default.replaceAll("'", "''")}'`;
        else if (typeof column.default === 'boolean') defaultSql = column.default ? '1' : '0';
        else defaultSql = String(column.default);
      }
      return { name: column.name, kind, required: column.notNull, primary: column.primary,
        unique: column.isUnique, defaultSql };
    })];
  }),
);

d1Tables.sessoes = [
  { name: 'id', kind: 'string', primary: true, required: true, unique: false, defaultSql: 'NULL' },
  { name: 'usuario_id', kind: 'string', primary: false, required: true, unique: false, defaultSql: 'NULL' },
  { name: 'expira_em', kind: 'timestamp', primary: false, required: true, unique: false, defaultSql: 'NULL' },
  { name: 'criado_em', kind: 'timestamp', primary: false, required: false, unique: false, defaultSql: D1_NOW },
];
d1Tables.backups = [
  { name: 'id', kind: 'string', primary: true, required: true, unique: false, defaultSql: 'NULL' },
  { name: 'tipo_gatilho', kind: 'string', primary: false, required: true, unique: false, defaultSql: "'manual'" },
  { name: 'dados', kind: 'json', primary: false, required: false, unique: false, defaultSql: 'NULL' },
  { name: 'tamanho_bytes', kind: 'number', primary: false, required: false, unique: false, defaultSql: '0' },
  { name: 'criado_em', kind: 'timestamp', primary: false, required: true, unique: false, defaultSql: D1_NOW },
];
const extra = (name: string, kind = 'string'): D1Column =>
  ({ name, kind, primary: false, required: false, unique: false, defaultSql: 'NULL' });
d1Tables.backups.push(extra('tamanho_armazenado_bytes', 'number'), extra('checksum_sha256'));

export function initialD1Statements(): string[] {
  return [...INITIAL_D1_V1_STATEMENTS];
}
export const d1AllocationTriggers = () => INITIAL_D1_V1_STATEMENTS.filter(s => s.startsWith('CREATE TRIGGER'));
export const d1DropAllocationTriggers = () => ['insert', 'update'].map(event => `DROP TRIGGER IF EXISTS vagas_cfc_guard_${event}`);

export async function d1Checksum(): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(initialD1Statements().join(';\n')));
  const checksum = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
  if (D1_VERSION === 'd1_schema_v1' && checksum !== D1_INITIAL_CHECKSUM) {
    throw new Error('A definição da migração D1 inicial foi alterada. Prepare uma nova versão; não reescreva o checksum liberado.');
  }
  return checksum;
}

// Explicit maintenance command only; never called from a production request.
export async function migrateD1(binding: D1Database): Promise<void> {
  const checksum = await d1Checksum();
  await binding.prepare(initialD1Statements().find(s => s.startsWith('CREATE TABLE IF NOT EXISTS migracoes_d1'))!).run();
  const applied = await binding.prepare('SELECT checksum FROM migracoes_d1 WHERE versao = ?').bind(D1_VERSION).first<{ checksum: string }>();
  if (applied) {
    if (applied.checksum !== checksum) throw new Error('A migração D1 aplicada foi modificada. Crie uma nova versão; não sobrescreva a anterior.');
    await migrateCpfD1(binding);
    await migrateCadastroTabsD1(binding);
    await migrateCnhModalityD1(binding);
    await migrateYardsInterestD1(binding);
    await migrateAuthSecurityD1(binding);
    await migrateCleanupV2D1(binding);
    await migratePiiV3D1(binding);
    return;
  }
  const existing = await binding.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  if (existing.results.some(r => !!d1Tables[r.name] || r.name === 'backups_partes')) {
    throw new Error('Destino D1 já contém tabelas sem a versão esperada. Use um ambiente novo; não adote nem altere o banco automaticamente.');
  }
  const statements = initialD1Statements().map(s => binding.prepare(s));
  // DDL + marker in one atomic batch. No BEGIN/COMMIT (D1 owns the transaction).
  await binding.batch([...statements, binding.prepare('INSERT INTO migracoes_d1 VALUES (?, ?, ?)')
    .bind(D1_VERSION, checksum, new Date().toISOString())]);
  await migrateCpfD1(binding);
  await migrateCadastroTabsD1(binding);
  await migrateCnhModalityD1(binding);
  await migrateYardsInterestD1(binding);
  await migrateAuthSecurityD1(binding);
  await migrateCleanupV2D1(binding);
  await migratePiiV3D1(binding);
}
