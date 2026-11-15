/**
 * Exporta 100% do banco PostgreSQL (Neon) para um arquivo .sql compatível com Cloudflare D1.
 *
 * Inclui:
 * - Criação do schema D1 inicial + todas as 5 migrações versionadas + registros em `migracoes_d1`
 * - 100% dos dados de todas as tabelas existentes no Neon (inclusive `usuarios.senha`, `logs_auditoria`, `sessoes`, etc.)
 * - Fragmentação automática de `backups.dados` em `backups_partes` (<= 40 KB por SQL statement, dentro do limite de 100 KB do D1)
 *
 * Uso:
 *   DATABASE_URL="postgres://..." npx tsx scripts/export-neon-to-d1.ts --out d1-migracao.sql
 *   npx wrangler d1 execute NOME_DO_BANCO_D1 --remote --file=d1-migracao.sql
 *
 * Para testar apenas a geração do schema (sem conectar ao Neon):
 *   npx tsx scripts/export-neon-to-d1.ts --schema-only --out d1-schema.sql
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import {
  d1Tables,
  D1_VERSION,
  d1Checksum,
  initialD1Statements,
  d1DropAllocationTriggers,
  d1AllocationTriggers,
  quote,
  type D1Column,
} from '../db/d1-schema.js';
import { CPF_D1_VERSION, CPF_D1_STATEMENTS, cpfD1Checksum } from '../db/cpf-migration.js';
import { CADASTRO_TABS_D1_VERSION, CADASTRO_TABS_D1_STATEMENTS, cadastroTabsD1Checksum } from '../db/cadastro-tabs-migration.js';
import { CNH_MODALITY_VERSION, CNH_MODALITY_STATEMENTS, cnhModalityChecksum } from '../db/cnh-exam-modality-migration.js';
import { YARDS_INTEREST_VERSION, YARDS_INTEREST_STATEMENTS, yardsInterestChecksum } from '../db/school-yards-interest-migration.js';
import { AUTH_SECURITY_VERSION, AUTH_SECURITY_DDL, authSecurityChecksum } from '../db/auth-security-migration.js';
import { CLEANUP_V2_VERSION, CLEANUP_V2_STATEMENTS, cleanupV2Checksum } from '../db/cleanup-v2-migration.js';

const BACKUP_PART_BYTES = 40_000; // Seguro abaixo do limite de 100 KB por statement do D1

function parseArgs(argv: string[]) {
  let outPath = 'd1-migracao.sql';
  let schemaOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--schema-only') schemaOnly = true;
    else if (arg === '--out' && argv[i + 1]) outPath = argv[++i];
    else if (arg.startsWith('--out=')) outPath = arg.slice('--out='.length);
  }
  return { outPath, schemaOnly };
}

function sqlString(value: string): string {
  // Remove eventuais bytes NUL que o SQLite/Wrangler rejeitam em literais de texto
  const clean = value.replace(/\0/g, '');
  return `'${clean.replaceAll("'", "''")}'`;
}

function splitUtf8Chunks(text: string, maxBytes: number): string[] {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length === 0) return [''];
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + maxBytes, bytes.length);
    // Evita cortar um caractere multibyte UTF-8 ao meio
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    if (end === start) end = Math.min(start + maxBytes, bytes.length);
    chunks.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return chunks;
}

function encodeD1Value(value: unknown, col: D1Column): string {
  if (value === null || value === undefined) {
    if (col.required && col.defaultSql !== 'NULL') return col.defaultSql;
    return 'NULL';
  }
  if (col.kind === 'boolean') {
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'number') return value ? '1' : '0';
    const s = String(value).trim().toLowerCase();
    return s === '1' || s === 'true' || s === 't' ? '1' : '0';
  }
  if (col.kind === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return col.required && col.defaultSql !== 'NULL' ? col.defaultSql : 'NULL';
    }
    return String(Math.trunc(n));
  }
  if (col.kind === 'json') {
    const jsonText = typeof value === 'string' ? value : JSON.stringify(value);
    return sqlString(jsonText);
  }
  if (col.kind === 'timestamp') {
    if (value instanceof Date) return sqlString(value.toISOString());
    return sqlString(String(value));
  }
  if (value instanceof Date) return sqlString(value.toISOString());
  if (typeof value === 'object') return sqlString(JSON.stringify(value));
  return sqlString(String(value));
}

async function buildSchemaStatements(): Promise<string[]> {
  const nowIso = new Date().toISOString();
  const [
    baseChecksum,
    cpfChecksum,
    tabsChecksum,
    modalityChecksum,
    yardsChecksum,
    authChecksum,
    cleanupChecksum,
  ] = await Promise.all([
    d1Checksum(),
    cpfD1Checksum(),
    cadastroTabsD1Checksum(),
    cnhModalityChecksum(),
    yardsInterestChecksum(),
    authSecurityChecksum(),
    cleanupV2Checksum(),
  ]);

  return [
    '-- ============================================================================',
    '-- PráticoSys — Migração completa Neon (PostgreSQL) -> Cloudflare D1 (SQLite)',
    `-- Gerado em: ${nowIso}`,
    '-- ============================================================================',
    '',
    '-- 1) Schema inicial D1',
    ...initialD1Statements().map(s => `${s.trim()};`),
    `INSERT OR IGNORE INTO "migracoes_d1" ("versao", "checksum", "aplicado_em") VALUES (${sqlString(D1_VERSION)}, ${sqlString(baseChecksum)}, ${sqlString(nowIso)});`,
    '',
    '-- 2) Migração CPF autofill & bloqueios de examinador',
    ...CPF_D1_STATEMENTS.map(s => `${s.trim()};`),
    `INSERT OR IGNORE INTO "migracoes_d1" ("versao", "checksum", "aplicado_em") VALUES (${sqlString(CPF_D1_VERSION)}, ${sqlString(cpfChecksum)}, ${sqlString(nowIso)});`,
    '',
    '-- 3) Migração abas de cadastro permitidas',
    ...CADASTRO_TABS_D1_STATEMENTS.map(s => `${s.trim()};`),
    `INSERT OR IGNORE INTO "migracoes_d1" ("versao", "checksum", "aplicado_em") VALUES (${sqlString(CADASTRO_TABS_D1_VERSION)}, ${sqlString(tabsChecksum)}, ${sqlString(nowIso)});`,
    '',
    '-- 4) Migração modalidades CNH Brasil',
    ...CNH_MODALITY_STATEMENTS.map(s => `${s.trim()};`),
    `INSERT OR IGNORE INTO "migracoes_d1" ("versao", "checksum", "aplicado_em") VALUES (${sqlString(CNH_MODALITY_VERSION)}, ${sqlString(modalityChecksum)}, ${sqlString(nowIso)});`,
    '',
    '-- 5) Migração pátios de autoescolas & interesse em prova extra',
    ...YARDS_INTEREST_STATEMENTS.map(s => `${s.trim()};`),
    `INSERT OR IGNORE INTO "migracoes_d1" ("versao", "checksum", "aplicado_em") VALUES (${sqlString(YARDS_INTEREST_VERSION)}, ${sqlString(yardsChecksum)}, ${sqlString(nowIso)});`,
    '',
    '-- 6) Migração segurança / rate limit de autenticação',
    `${AUTH_SECURITY_DDL.trim()};`,
    `INSERT OR IGNORE INTO "migracoes_d1" ("versao", "checksum", "aplicado_em") VALUES (${sqlString(AUTH_SECURITY_VERSION)}, ${sqlString(authChecksum)}, ${sqlString(nowIso)});`,
    '',
    '-- 7) Reorganização e limpeza de schema D1 (v2)',
    ...CLEANUP_V2_STATEMENTS.map(s => `${s.trim()};`),
    `INSERT OR IGNORE INTO "migracoes_d1" ("versao", "checksum", "aplicado_em") VALUES (${sqlString(CLEANUP_V2_VERSION)}, ${sqlString(cleanupChecksum)}, ${sqlString(nowIso)});`,
    '',
  ];
}

async function main() {
  const { outPath, schemaOnly } = parseArgs(process.argv.slice(2));
  const resolvedOut = path.resolve(process.cwd(), outPath);
  const lines: string[] = await buildSchemaStatements();

  if (schemaOnly) {
    fs.writeFileSync(resolvedOut, `${lines.join('\n')}\n`, 'utf8');
    console.log(`Schema D1 gerado em: ${resolvedOut} (${lines.length} linhas)`);
    return;
  }

  const connectionString = process.env.DATA_BASE_NEON ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Erro: defina DATABASE_URL (ou DATA_BASE_NEON) com a URL do seu Neon antes de rodar.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
      ? undefined
      : { rejectUnauthorized: false },
  });

  try {
    const tablesRes = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const existingTables = new Set(tablesRes.rows.map(r => r.table_name));

    const colsRes = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
    );
    const pgColumnsByTable = new Map<string, Set<string>>();
    for (const row of colsRes.rows) {
      if (!pgColumnsByTable.has(row.table_name)) pgColumnsByTable.set(row.table_name, new Set());
      pgColumnsByTable.get(row.table_name)!.add(row.column_name);
    }

    // Remove triggers temporariamente durante carga histórica (igual ao restoreD1Backup)
    lines.push('-- 7) Desativação temporária dos triggers de alocação para carga histórica');
    for (const stmt of d1DropAllocationTriggers()) lines.push(`${stmt};`);
    lines.push('');

    const tableNames = Object.keys(d1Tables).filter(t => existingTables.has(t));
    // Garante que `backups` seja processado normalmente e gera `backups_partes` em seguida
    let totalRows = 0;

    for (const tableName of tableNames) {
      const pgCols = pgColumnsByTable.get(tableName) ?? new Set<string>();
      const targetCols = d1Tables[tableName].filter(col => {
        if (tableName === 'backups' && (col.name === 'tamanho_armazenado_bytes' || col.name === 'checksum_sha256')) {
          return true;
        }
        return pgCols.has(col.name);
      });

      if (targetCols.length === 0) continue;

      const extraTaxaBool = (tableName === 'solicitacoes_cnhbrasil' || tableName === 'solicitacoes_pcd')
        && pgCols.has('taxa_paga_bool');
      const selectColList = [
        ...targetCols.filter(c => pgCols.has(c.name)).map(c => quote(c.name)),
        ...(extraTaxaBool ? [quote('taxa_paga_bool')] : []),
      ];
      const selectCols = selectColList.join(', ');
      if (!selectCols) continue;

      const dataRes = await pool.query(`SELECT ${selectCols} FROM ${quote(tableName)}`);
      const rows = dataRes.rows.map(r => extraTaxaBool ? { ...r, taxa_paga: Boolean(r.taxa_paga || r.taxa_paga_bool) } : r);

      lines.push(`-- Tabela ${tableName}: ${rows.length} registro(s)`);
      if (rows.length === 0) {
        lines.push('');
        continue;
      }

      if (tableName === 'backups') {
        const colList = targetCols.map(c => quote(c.name)).join(', ');
        for (const row of rows) {
          const payloadText = row.dados == null
            ? '{}'
            : typeof row.dados === 'string' ? row.dados : JSON.stringify(row.dados);
          const payloadBytes = Buffer.byteLength(payloadText, 'utf8');
          const checksum = crypto.createHash('sha256').update(payloadText, 'utf8').digest('hex');

          const values = targetCols.map(col => {
            if (col.name === 'dados') return 'NULL';
            if (col.name === 'tamanho_bytes') return String(Math.trunc(Number(row.tamanho_bytes ?? payloadBytes)));
            if (col.name === 'tamanho_armazenado_bytes') return String(payloadBytes);
            if (col.name === 'checksum_sha256') return sqlString(checksum);
            return encodeD1Value(row[col.name], col);
          });
          lines.push(`INSERT OR REPLACE INTO "backups" (${colList}) VALUES (${values.join(', ')});`);

          const parts = splitUtf8Chunks(payloadText, BACKUP_PART_BYTES);
          for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            lines.push(
              `INSERT OR REPLACE INTO "backups_partes" ("backup_id", "parte", "dados") VALUES (${sqlString(String(row.id))}, ${partIndex}, ${sqlString(parts[partIndex])});`
            );
          }
          totalRows++;
        }
        lines.push('');
        continue;
      }

      const colList = targetCols.map(c => quote(c.name)).join(', ');
      for (const row of rows) {
        const values = targetCols.map(col => encodeD1Value(row[col.name], col));
        lines.push(`INSERT OR REPLACE INTO ${quote(tableName)} (${colList}) VALUES (${values.join(', ')});`);
        totalRows++;
      }
      lines.push('');
    }

    lines.push('-- 8) Reativação dos triggers de alocação');
    for (const stmt of d1AllocationTriggers()) lines.push(`${stmt};`);
    lines.push('');

    fs.writeFileSync(resolvedOut, `${lines.join('\n')}\n`, 'utf8');
    console.log(`Exportação concluída com sucesso!`);
    console.log(`Arquivo: ${resolvedOut}`);
    console.log(`Tabelas exportadas: ${tableNames.length} | Registros totais: ${totalRows}`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Falha ao exportar Neon para D1:', err);
  process.exit(1);
});
