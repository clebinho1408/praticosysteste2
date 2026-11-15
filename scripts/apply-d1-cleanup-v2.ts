/**
 * Gera o script SQL da migração `d1_schema_cleanup_v2` para aplicar em um
 * banco Cloudflare D1 já existente (via Wrangler ou GitHub Actions).
 *
 * Uso:
 *   npx tsx scripts/apply-d1-cleanup-v2.ts --out /tmp/d1-cleanup-v2.sql
 *   npx tsx scripts/apply-d1-cleanup-v2.ts --print-checksum
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CLEANUP_V2_VERSION,
  CLEANUP_V2_STATEMENTS,
  cleanupV2Checksum,
} from '../db/cleanup-v2-migration.js';

function parseArgs(argv: string[]) {
  let outPath = 'd1-cleanup-v2.sql';
  let printChecksum = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--print-checksum') printChecksum = true;
    else if (arg === '--out' && argv[i + 1]) outPath = argv[++i];
    else if (arg.startsWith('--out=')) outPath = arg.slice('--out='.length);
  }
  return { outPath, printChecksum };
}

function sqlString(value: string): string {
  return `'${value.replace(/\0/g, '').replaceAll("'", "''")}'`;
}

async function main() {
  const { outPath, printChecksum } = parseArgs(process.argv.slice(2));
  const checksum = await cleanupV2Checksum();
  if (printChecksum) {
    console.log(JSON.stringify({ version: CLEANUP_V2_VERSION, checksum }));
    return;
  }
  const nowIso = new Date().toISOString();
  const lines = [
    '-- ============================================================================',
    `-- PráticoSys — Limpeza e Reorganização do Schema D1 (${CLEANUP_V2_VERSION})`,
    `-- Gerado em: ${nowIso}`,
    `-- Checksum: ${checksum}`,
    '-- ============================================================================',
    '',
    ...CLEANUP_V2_STATEMENTS.map(s => `${s.trim()};`),
    `INSERT OR IGNORE INTO "migracoes_d1" ("versao", "checksum", "aplicado_em") VALUES (${sqlString(CLEANUP_V2_VERSION)}, ${sqlString(checksum)}, ${sqlString(nowIso)});`,
    '',
  ];
  const resolvedOut = path.resolve(process.cwd(), outPath);
  fs.writeFileSync(resolvedOut, lines.join('\n'), 'utf8');
  console.log(`Script ${CLEANUP_V2_VERSION} gerado em: ${resolvedOut} (${CLEANUP_V2_STATEMENTS.length} instruções DDL/DML, checksum ${checksum})`);
}

main().catch(err => {
  console.error('Erro ao gerar script cleanup-v2:', err);
  process.exit(1);
});
