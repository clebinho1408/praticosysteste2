import type { D1Database } from './d1-types.js';

export const NON_ROTATION_V4_VERSION = 'd1_non_rotation_capacity_v4';

export const VAGAS_CFC_TRIGGERS_V4: readonly string[] = [
  `CREATE TRIGGER IF NOT EXISTS vagas_cfc_guard_insert
      BEFORE INSERT ON vagas_cfc
       WHEN true
         AND NEW.status != 'CANCELLED' AND NEW.examinador_id IS NOT NULL
        AND NEW.data_agendada IS NOT NULL AND NEW.hora_agendada IS NOT NULL
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM vagas_cfc WHERE examinador_id = NEW.examinador_id
          AND data_agendada = NEW.data_agendada AND hora_agendada = NEW.hora_agendada
          AND status != 'CANCELLED' AND id != NEW.id
        ) THEN RAISE(ABORT, 'D1_EXAMINER_CONFLICT') END;
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM autoescolas WHERE id = NEW.autoescola_id AND rodizio_provas = 1
        ) AND (
          SELECT count(*) FROM vagas_cfc WHERE examinador_id = NEW.examinador_id
          AND data_agendada = NEW.data_agendada AND status != 'CANCELLED' AND id != NEW.id
        ) >= (
          SELECT json_extract(disponibilidade_rodizio, '$.examsPerDay')
          FROM examinadores WHERE id = NEW.examinador_id AND rodizio_provas = 1
        ) THEN RAISE(ABORT, 'D1_EXAMINER_CAPACITY') END;
      END`,
  `CREATE TRIGGER IF NOT EXISTS vagas_cfc_guard_update
      BEFORE UPDATE ON vagas_cfc
       WHEN (NEW.examinador_id IS NOT OLD.examinador_id
         OR NEW.data_agendada IS NOT OLD.data_agendada OR NEW.hora_agendada IS NOT OLD.hora_agendada
         OR (OLD.status = 'CANCELLED' AND NEW.status != 'CANCELLED')
         OR NEW.autoescola_id IS NOT OLD.autoescola_id)
         AND NEW.status != 'CANCELLED' AND NEW.examinador_id IS NOT NULL
        AND NEW.data_agendada IS NOT NULL AND NEW.hora_agendada IS NOT NULL
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM vagas_cfc WHERE examinador_id = NEW.examinador_id
          AND data_agendada = NEW.data_agendada AND hora_agendada = NEW.hora_agendada
          AND status != 'CANCELLED' AND id != NEW.id
        ) THEN RAISE(ABORT, 'D1_EXAMINER_CONFLICT') END;
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM autoescolas WHERE id = NEW.autoescola_id AND rodizio_provas = 1
        ) AND (
          SELECT count(*) FROM vagas_cfc WHERE examinador_id = NEW.examinador_id
          AND data_agendada = NEW.data_agendada AND status != 'CANCELLED' AND id != NEW.id
        ) >= (
          SELECT json_extract(disponibilidade_rodizio, '$.examsPerDay')
          FROM examinadores WHERE id = NEW.examinador_id AND rodizio_provas = 1
        ) THEN RAISE(ABORT, 'D1_EXAMINER_CAPACITY') END;
      END`,
];

export const NON_ROTATION_V4_STATEMENTS: string[] = [
  'DROP TRIGGER IF EXISTS vagas_cfc_guard_insert',
  'DROP TRIGGER IF EXISTS vagas_cfc_guard_update',
  ...VAGAS_CFC_TRIGGERS_V4,
];

export async function nonRotationV4Checksum(): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(NON_ROTATION_V4_STATEMENTS.join(';\n')),
  );
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
}

export async function migrateNonRotationV4D1(binding: D1Database): Promise<void> {
  const checksum = await nonRotationV4Checksum();
  const applied = await binding.prepare('SELECT checksum FROM migracoes_d1 WHERE versao = ?')
    .bind(NON_ROTATION_V4_VERSION).first<{ checksum: string }>();
  if (applied) {
    if (applied.checksum !== checksum) {
      throw new Error('Migração D1 de capacidade sem rodízio (v4) modificada após aplicada.');
    }
    return;
  }

  await binding.batch([
    ...NON_ROTATION_V4_STATEMENTS.map(s => binding.prepare(s)),
    binding.prepare('INSERT INTO migracoes_d1 (versao, checksum, aplicado_em) VALUES (?, ?, ?)')
      .bind(NON_ROTATION_V4_VERSION, checksum, new Date().toISOString()),
  ]);
}
