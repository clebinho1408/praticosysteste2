/**
 * Gera o script SQL da migração `d1_cpf_security_v3` e, opcionalmente, gera
 * comandos UPDATE idempotentes para criptografar dados sensíveis já existentes
 * no Cloudflare D1 (AES-256-GCM + HMAC-SHA256 + máscara em logs de auditoria).
 *
 * Uso:
 *   npx tsx scripts/apply-d1-pii-v3.ts --print-checksum
 *   npx tsx scripts/apply-d1-pii-v3.ts --out /tmp/d1-pii-v3.sql
 *   DATA_ENCRYPTION_KEY="..." npx tsx scripts/apply-d1-pii-v3.ts --encrypt-dump /tmp/dump.json --out /tmp/d1-encrypt-updates.sql
 */

import fs from 'node:fs';
import path from 'node:path';
import { PII_V3_STATEMENTS, PII_V3_VERSION, piiV3Checksum } from '../db/pii-v3-migration.js';
import {
  computeCpfHmac,
  decryptField,
  encryptField,
  isEncryptedValue,
  maskAuditDetails,
  type PiiCryptoEnv,
} from '../db/pii-crypto.js';

function parseArgs(argv: string[]) {
  let outPath = 'd1-pii-v3.sql';
  let printChecksum = false;
  let encryptDumpPath = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--print-checksum') printChecksum = true;
    else if (arg === '--out' && argv[i + 1]) outPath = argv[++i];
    else if (arg.startsWith('--out=')) outPath = arg.slice('--out='.length);
    else if (arg === '--encrypt-dump' && argv[i + 1]) encryptDumpPath = argv[++i];
    else if (arg.startsWith('--encrypt-dump=')) encryptDumpPath = arg.slice('--encrypt-dump='.length);
  }
  return { outPath, printChecksum, encryptDumpPath };
}

function sqlVal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  const str = String(value).replace(/\0/g, '');
  return `'${str.replaceAll("'", "''")}'`;
}

export async function buildEncryptUpdateStatements(
  dump: {
    solicitacoes_cnhbrasil?: Record<string, any>[];
    solicitacoes_pcd?: Record<string, any>[];
    instrutores?: Record<string, any>[];
    logs_auditoria?: Record<string, any>[];
  },
  env: PiiCryptoEnv,
): Promise<{ statements: string[]; counts: Record<string, number> }> {
  if (!env.DATA_ENCRYPTION_KEY?.trim()) {
    throw new Error('Defina DATA_ENCRYPTION_KEY para gerar as atualizações de criptografia.');
  }

  const statements: string[] = [];
  const counts: Record<string, number> = {
    solicitacoes_cnhbrasil: 0,
    solicitacoes_pcd: 0,
    instrutores: 0,
    logs_auditoria: 0,
  };

  const processTable = async (
    table: 'solicitacoes_cnhbrasil' | 'solicitacoes_pcd' | 'instrutores',
    rows: Record<string, any>[],
    piiFields: string[],
  ) => {
    for (const row of rows) {
      if (!row?.id) continue;
      const sets: string[] = [];

      if (row.cpf !== undefined && row.cpf !== null && row.cpf !== '') {
        const plainCpf = isEncryptedValue(row.cpf) ? await decryptField(row.cpf, env) : row.cpf;
        const expectedHmac = await computeCpfHmac(plainCpf, env);
        if (expectedHmac && row.cpf_hmac !== expectedHmac) {
          sets.push(`"cpf_hmac" = ${sqlVal(expectedHmac)}`);
        }
      }

      for (const field of piiFields) {
        const current = row[field];
        if (typeof current === 'string' && current !== '' && !isEncryptedValue(current)) {
          const encrypted = await encryptField(current, env);
          sets.push(`"${field}" = ${sqlVal(encrypted)}`);
        }
      }

      if (sets.length > 0) {
        statements.push(`UPDATE "${table}" SET ${sets.join(', ')} WHERE "id" = ${sqlVal(row.id)};`);
        counts[table]++;
      }
    }
  };

  await processTable('solicitacoes_cnhbrasil', dump.solicitacoes_cnhbrasil ?? [], ['cpf', 'telefone', 'email', 'endereco']);
  await processTable('solicitacoes_pcd', dump.solicitacoes_pcd ?? [], ['cpf', 'telefone', 'email', 'endereco']);
  await processTable('instrutores', dump.instrutores ?? [], ['cpf', 'telefone']);

  for (const log of dump.logs_auditoria ?? []) {
    if (!log?.id || !log.detalhes) continue;
    let parsed: any = log.detalhes;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { continue; }
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.cpf) continue;
    const masked = maskAuditDetails(parsed);
    if (masked.cpf !== parsed.cpf) {
      statements.push(
        `UPDATE "logs_auditoria" SET "detalhes" = ${sqlVal(JSON.stringify(masked))} WHERE "id" = ${sqlVal(log.id)};`,
      );
      counts.logs_auditoria++;
    }
  }

  return { statements, counts };
}

async function main() {
  const { outPath, printChecksum, encryptDumpPath } = parseArgs(process.argv.slice(2));
  const checksum = await piiV3Checksum();

  if (printChecksum) {
    console.log(JSON.stringify({ version: PII_V3_VERSION, checksum }));
    return;
  }

  const resolvedOut = path.resolve(process.cwd(), outPath);
  const nowIso = new Date().toISOString();

  if (encryptDumpPath) {
    const raw = fs.readFileSync(path.resolve(process.cwd(), encryptDumpPath), 'utf8');
    const dump = JSON.parse(raw);
    const { statements, counts } = await buildEncryptUpdateStatements(dump, process.env);
    const content = [
      '-- ============================================================================',
      `-- PráticoSys — Criptografia retroativa de PII no D1 (${PII_V3_VERSION})`,
      `-- Gerado em: ${nowIso}`,
      '-- ============================================================================',
      '',
      ...statements,
      '',
    ].join('\n');
    fs.writeFileSync(resolvedOut, content, 'utf8');
    console.log(JSON.stringify({ totalStatements: statements.length, counts }));
    return;
  }

  const lines = [
    '-- ============================================================================',
    `-- PráticoSys — Segurança CPF / Índice Cego HMAC (${PII_V3_VERSION})`,
    `-- Gerado em: ${nowIso}`,
    `-- Checksum: ${checksum}`,
    '-- ============================================================================',
    '',
    ...PII_V3_STATEMENTS.map(s => `${s.trim()};`),
    `INSERT OR IGNORE INTO "migracoes_d1" ("versao", "checksum", "aplicado_em") VALUES (${sqlVal(PII_V3_VERSION)}, ${sqlVal(checksum)}, ${sqlVal(nowIso)});`,
    '',
  ];
  fs.writeFileSync(resolvedOut, lines.join('\n'), 'utf8');
  console.log(`Script ${PII_V3_VERSION} gerado em: ${resolvedOut} (${PII_V3_STATEMENTS.length} instruções DDL, checksum ${checksum})`);
}

const isCli = typeof process !== 'undefined' && process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isCli) {
  main().catch(err => {
    console.error('Erro ao gerar script pii-v3:', err);
    process.exit(1);
  });
}
