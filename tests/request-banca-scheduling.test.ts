import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { coerceOptionalTimestamp } from '../functions/_request-timestamps.js';

test('coerceOptionalTimestamp handles ISO strings, empty/invalid strings, Date, and null/undefined', () => {
  assert.equal(coerceOptionalTimestamp(undefined), undefined);
  assert.equal(coerceOptionalTimestamp(null), null);
  assert.equal(coerceOptionalTimestamp(''), null);
  assert.equal(coerceOptionalTimestamp('   '), null);
  assert.equal(coerceOptionalTimestamp('not-a-date'), null);

  const iso = '2026-11-19T16:22:39.746Z';
  const parsed = coerceOptionalTimestamp(iso);
  assert.ok(parsed instanceof Date);
  assert.equal(parsed.toISOString(), iso);

  const existing = new Date('2026-11-20T10:00:00.000Z');
  assert.equal(coerceOptionalTimestamp(existing), existing);
  assert.equal(coerceOptionalTimestamp(new Date('invalid')), null);
});

test('assignStudentToSchedule payload updates cnhbrasilRequests queueUpdatedAt without Drizzle PgTimestamp error', async () => {
  const client = new PGlite();
  await client.exec(`
    CREATE TABLE solicitacoes_cnhbrasil (
      id text PRIMARY KEY,
      nome_candidato text,
      nome_social text,
      cpf text,
      cpf_hmac text,
      telefone text,
      email text,
      endereco text,
      cidade text,
      tipo_solicitacao text DEFAULT 'EXTRA',
      tipo_exame text NOT NULL,
      categoria_pretendida text DEFAULT 'B',
      origem text NOT NULL,
      curso_pratico_concluido boolean DEFAULT false,
      horas_praticas integer DEFAULT 0,
      tem_veiculo boolean DEFAULT false,
      restricao_cnh text,
      instrutor text,
      modalidade_exame_a text,
      modalidade_exame_b text,
      placa_veiculo text,
      sem_duplo_comando boolean DEFAULT false,
      checklist_veiculo boolean DEFAULT false,
      curso_pratico_inserido boolean DEFAULT false,
      taxa_paga boolean DEFAULT false,
      status text NOT NULL,
      resultado text,
      banca_id text,
      data_agendada text,
      hora_agendada text,
      categoria_agendada text,
      examinador_id text,
      presenca_confirmada boolean DEFAULT false,
      motivo_cancelamento text,
      observacao text,
      historico_exames jsonb DEFAULT '[]'::jsonb,
      modulo text,
      cor_linha text,
      criado_em timestamp DEFAULT now(),
      atualizado_em timestamp DEFAULT now(),
      fila_atualizado_em timestamp,
      agendado_por text
    );
  `);
  const db = drizzle(client, { schema });

  const id = 'cand-banca-1';
  await db.insert(schema.cnhbrasilRequests).values({
    id,
    studentName: 'MARCIA JOSIANE GONCALVES ALVES',
    cpf: '12345678900',
    examType: 'COMMON',
    intendedCategory: 'B',
    source: 'PUBLIC',
    status: 'WAITING_SCHEDULING',
    modulo: 'CNH_BRASIL',
  });

  const payload = {
    scheduleId: 'banca-1',
    scheduledCategory: 'B',
    status: 'SCHEDULED',
    queueUpdatedAt: coerceOptionalTimestamp('2026-11-19T16:22:39.746Z'),
    scheduledBy: 'Administrador',
    updatedAt: new Date(),
  };

  const [updated] = await db
    .update(schema.cnhbrasilRequests)
    .set(payload)
    .where(eq(schema.cnhbrasilRequests.id, id))
    .returning();

  assert.equal(updated.status, 'SCHEDULED');
  assert.equal(updated.scheduleId, 'banca-1');
  assert.equal(updated.scheduledCategory, 'B');
  assert.equal(updated.queueUpdatedAt?.toISOString(), '2026-11-19T16:22:39.746Z');

  await client.close();
});
