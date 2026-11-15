import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '../db/schema.js';
import { D1_VERSION, d1Checksum } from '../db/d1-schema.js';
import { CPF_D1_VERSION, cpfD1Checksum } from '../db/cpf-migration.js';
import { CADASTRO_TABS_D1_VERSION, cadastroTabsD1Checksum } from '../db/cadastro-tabs-migration.js';
import { CNH_MODALITY_VERSION, cnhModalityChecksum } from '../db/cnh-exam-modality-migration.js';
import { YARDS_INTEREST_VERSION, yardsInterestChecksum } from '../db/school-yards-interest-migration.js';
import { translateD1Sql, decodeD1Row } from './_d1-sql.js';
import { AUTH_SECURITY_VERSION, authSecurityChecksum } from '../db/auth-security-migration.js';
import type { D1Database, D1Result } from '../db/d1-types.js';

export const isD1 = (db: any): boolean => !!db.$d1;
export const d1Binding = (db: any): D1Database => {
  if (!db.$d1) throw new Error('Operação requer D1.');
  return db.$d1;
};

const verifiedBindings = new WeakSet<object>();

export async function verifyD1Schema(db: any) {
  if (!isD1(db)) return;
  if (db.$d1Verified) return;
  const binding = d1Binding(db);
  if (verifiedBindings.has(binding as unknown as object)) {
    db.$d1Verified = true;
    return;
  }
  const rows = await binding.prepare('SELECT versao, checksum FROM migracoes_d1')
    .all<{ versao: string; checksum: string }>();
  const map = new Map((rows.results ?? []).map(r => [r.versao, r.checksum]));
  const [cBase, cCpf, cTabs, cModality, cYards, cAuth] = await Promise.all([
    d1Checksum(),
    cpfD1Checksum(),
    cadastroTabsD1Checksum(),
    cnhModalityChecksum(),
    yardsInterestChecksum(),
    authSecurityChecksum(),
  ]);
  if (map.get(D1_VERSION) !== cBase) throw new Error('Migrações D1 ausentes ou incompatíveis. Execute a manutenção de schema antes de usar o ambiente.');
  if (map.get(CPF_D1_VERSION) !== cCpf) throw new Error('Migração D1 de autopreenchimento ausente ou incompatível. Execute a manutenção de schema.');
  if (map.get(CADASTRO_TABS_D1_VERSION) !== cTabs) throw new Error('Migração D1 de abas de cadastro ausente ou incompatível. Execute a manutenção de schema.');
  if (map.get(CNH_MODALITY_VERSION) !== cModality) throw new Error('Migração D1 de modalidades CNH ausente ou incompatível. Execute a manutenção de schema.');
  if (map.get(YARDS_INTEREST_VERSION) !== cYards) throw new Error('Migração D1 de pátios/interesse ausente ou incompatível. Execute a manutenção de schema.');
  if (map.get(AUTH_SECURITY_VERSION) !== cAuth) throw new Error('Migração D1 de segurança ausente. Execute a manutenção local de schema.');
  verifiedBindings.add(binding as unknown as object);
  db.$d1Verified = true;
}

export function createD1Db(binding: D1Database) {
  type Descriptor = { sql: string; params: unknown[]; options: { arrayMode?: boolean } };
  const prepared = (q: Descriptor) => {
    const translated = translateD1Sql(q.sql, q.params);
    return binding.prepare(translated.sql).bind(...translated.params as any[]);
  };
  const result = (r: D1Result, q: Descriptor) => ({
    rows: (r.results ?? []).map(row => decodeD1Row(row as Record<string, unknown>, q.options.arrayMode)),
    rowCount: r.meta.changes, command: q.sql.trim().split(/\s/)[0].toUpperCase(),
  });
  const client: any = (sql: string, params: unknown[] = [], options: Descriptor['options'] = {}) => {
    const descriptor = { sql, params, options };
    // Queries must remain lazy: Drizzle builds them before calling .batch().
    let execution: Promise<unknown> | undefined;
    const run = async () => {
      const alter = /^\s*ALTER TABLE (?:public\.)?(\w+) ADD COLUMN IF NOT EXISTS (\w+)/i.exec(sql);
      if (alter) {
        const info = await binding.prepare(`PRAGMA table_info("${alter[1]}")`).all<{ name: string }>();
        if (!info.results.some(c => c.name === alter[2])) throw new Error('Coluna D1 ausente; aplique uma migração versionada.');
        return { rows: [], rowCount: 0 };
      }
      return result(await prepared(descriptor).all(), descriptor);
    };
    return Object.assign(descriptor, {
      then(resolve: any, reject: any) { execution ??= run(); return execution.then(resolve, reject); },
    });
  };
  client.transaction = async (queries: Descriptor[]) => {
    if (queries.length > 40) throw new Error('Lote D1 excede o limite seguro de 40 consultas; nenhuma gravação foi executada.');
    const results = await binding.batch(queries.map(prepared));
    return results.map((r, i) => result(r, queries[i]));
  };
  const db = drizzle(client, { schema });
  Object.assign(db, { $d1: binding });
  return db;
}
