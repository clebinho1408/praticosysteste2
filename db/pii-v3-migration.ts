import type { D1Database } from './d1-types.js';

export const PII_V3_VERSION = 'd1_cpf_security_v3';

export const PII_V3_STATEMENTS: string[] = [
  'ALTER TABLE "solicitacoes_cnhbrasil" ADD COLUMN "cpf_hmac" TEXT',
  'ALTER TABLE "solicitacoes_pcd" ADD COLUMN "cpf_hmac" TEXT',
  'ALTER TABLE "instrutores" ADD COLUMN "cpf_hmac" TEXT',
  'CREATE INDEX IF NOT EXISTS solicitacoes_cnhbrasil_cpf_hmac ON solicitacoes_cnhbrasil (cpf_hmac)',
  'CREATE INDEX IF NOT EXISTS solicitacoes_pcd_cpf_hmac ON solicitacoes_pcd (cpf_hmac)',
  'CREATE INDEX IF NOT EXISTS instrutores_cpf_hmac ON instrutores (cpf_hmac)',
];

export const PII_V3_NEON_SQL = `
  ALTER TABLE solicitacoes_cnhbrasil ADD COLUMN IF NOT EXISTS cpf_hmac text;
  ALTER TABLE solicitacoes_pcd ADD COLUMN IF NOT EXISTS cpf_hmac text;
  ALTER TABLE instrutores ADD COLUMN IF NOT EXISTS cpf_hmac text;
  CREATE INDEX IF NOT EXISTS solicitacoes_cnhbrasil_cpf_hmac ON solicitacoes_cnhbrasil (cpf_hmac);
  CREATE INDEX IF NOT EXISTS solicitacoes_pcd_cpf_hmac ON solicitacoes_pcd (cpf_hmac);
  CREATE INDEX IF NOT EXISTS instrutores_cpf_hmac ON instrutores (cpf_hmac);
`;

export async function piiV3Checksum(): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PII_V3_STATEMENTS.join(';\n')));
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
}

export async function migratePiiV3D1(binding: D1Database): Promise<void> {
  const checksum = await piiV3Checksum();
  const applied = await binding.prepare('SELECT checksum FROM migracoes_d1 WHERE versao = ?')
    .bind(PII_V3_VERSION).first<{ checksum: string }>();
  if (applied) {
    if (applied.checksum !== checksum) {
      throw new Error('Migração D1 de segurança CPF (v3) modificada após aplicada.');
    }
    return;
  }

  const hasCol = async (table: string, col: string) => {
    const info = await binding.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
    return info.results.some(c => c.name === col);
  };

  const pending: string[] = [];
  if (!await hasCol('solicitacoes_cnhbrasil', 'cpf_hmac')) {
    pending.push(PII_V3_STATEMENTS[0]);
  }
  if (!await hasCol('solicitacoes_pcd', 'cpf_hmac')) {
    pending.push(PII_V3_STATEMENTS[1]);
  }
  if (!await hasCol('instrutores', 'cpf_hmac')) {
    pending.push(PII_V3_STATEMENTS[2]);
  }
  pending.push(PII_V3_STATEMENTS[3], PII_V3_STATEMENTS[4], PII_V3_STATEMENTS[5]);

  await binding.batch([
    ...pending.map(s => binding.prepare(s)),
    binding.prepare('INSERT INTO migracoes_d1 (versao, checksum, aplicado_em) VALUES (?, ?, ?)')
      .bind(PII_V3_VERSION, checksum, new Date().toISOString()),
  ]);
}
