import type { D1Database } from './d1-types.js';

export const CLEANUP_V2_VERSION = 'd1_schema_cleanup_v2';
const D1_NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

const VAGAS_CFC_TRIGGERS = [
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
        SELECT CASE WHEN (
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
         OR (OLD.status = 'CANCELLED' AND NEW.status != 'CANCELLED'))
         AND NEW.status != 'CANCELLED' AND NEW.examinador_id IS NOT NULL
        AND NEW.data_agendada IS NOT NULL AND NEW.hora_agendada IS NOT NULL
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM vagas_cfc WHERE examinador_id = NEW.examinador_id
          AND data_agendada = NEW.data_agendada AND hora_agendada = NEW.hora_agendada
          AND status != 'CANCELLED' AND id != NEW.id
        ) THEN RAISE(ABORT, 'D1_EXAMINER_CONFLICT') END;
        SELECT CASE WHEN (
          SELECT count(*) FROM vagas_cfc WHERE examinador_id = NEW.examinador_id
          AND data_agendada = NEW.data_agendada AND status != 'CANCELLED' AND id != NEW.id
        ) >= (
          SELECT json_extract(disponibilidade_rodizio, '$.examsPerDay')
          FROM examinadores WHERE id = NEW.examinador_id AND rodizio_provas = 1
        ) THEN RAISE(ABORT, 'D1_EXAMINER_CAPACITY') END;
      END`,
];

const CNH_COLS = [
  '"id"', '"nome_candidato"', '"nome_social"', '"cpf"', '"telefone"', '"email"', '"endereco"', '"cidade"',
  '"tipo_solicitacao"', '"tipo_exame"', '"categoria_pretendida"', '"origem"',
  '"curso_pratico_concluido"', '"horas_praticas"', '"tem_veiculo"', '"restricao_cnh"', '"instrutor"',
  '"modalidade_exame_a"', '"modalidade_exame_b"', '"placa_veiculo"', '"sem_duplo_comando"',
  '"checklist_veiculo"', '"curso_pratico_inserido"', '"taxa_paga"', '"status"', '"resultado"',
  '"banca_id"', '"data_agendada"', '"hora_agendada"', '"categoria_agendada"', '"examinador_id"',
  '"presenca_confirmada"', '"motivo_cancelamento"', '"observacao"', '"historico_exames"', '"modulo"',
  '"cor_linha"', '"criado_em"', '"atualizado_em"', '"fila_atualizado_em"', '"agendado_por"',
].join(', ');

const CFC_COLS = [
  '"id"', '"tipo_solicitacao"', '"tipo_exame"', '"categoria_pretendida"', '"origem"', '"autoescola_id"',
  '"status"', '"resultado"', '"banca_id"', '"data_agendada"', '"hora_agendada"', '"categoria_agendada"',
  '"examinador_id"', '"presenca_confirmada"', '"motivo_cancelamento"', '"observacao"',
  '"quantidades_categoria"', '"examinadores_interessados"', '"modulo"', '"cor_linha"',
  '"criado_em"', '"atualizado_em"', '"fila_atualizado_em"', '"agendado_por"',
].join(', ');

const PCD_COLS = [
  '"id"', '"nome_candidato"', '"nome_social"', '"cpf"', '"telefone"', '"email"', '"endereco"', '"cidade"',
  '"tipo_solicitacao"', '"tipo_exame"', '"categoria_pretendida"', '"origem"', '"autoescola_id"',
  '"curso_pratico_concluido"', '"horas_praticas"', '"tem_veiculo"', '"restricao_cnh"', '"instrutor"',
  '"placa_veiculo"', '"checklist_veiculo"', '"curso_pratico_inserido"', '"taxa_paga"',
  '"tipo_deficiencia"', '"necessidades_especiais"', '"status"', '"resultado"', '"banca_id"',
  '"data_agendada"', '"hora_agendada"', '"categoria_agendada"', '"examinador_id"',
  '"presenca_confirmada"', '"motivo_cancelamento"', '"observacao"', '"historico_exames"', '"modulo"',
  '"cor_linha"', '"criado_em"', '"atualizado_em"', '"fila_atualizado_em"', '"agendado_por"',
].join(', ');

const VAGA_COLS = [
  '"id"', '"autoescola_id"', '"tipo_exame"', '"tipo_solicitacao"', '"categoria_pretendida"',
  '"data_agendada"', '"hora_agendada"', '"examinador_id"', '"banca_id"', '"categoria_agendada"',
  '"status"', '"presenca_confirmada"', '"motivo_cancelamento"', '"observacao"',
  '"quantidades_categoria"', '"criado_em"', '"atualizado_em"',
].join(', ');

/**
 * Limpeza e reorganização estrutural do D1 (v2):
 * - Remove 21 colunas de candidato/não usadas de `solicitacoes_cfc` (deixa apenas 24 colunas do módulo CFC)
 * - Remove `autoescola_id`, `taxa_paga_bool` e `cpf_hash` de `solicitacoes_cnhbrasil`
 * - Remove `taxa_paga_bool` e `cpf_hash` de `solicitacoes_pcd`
 * - Copia quaisquer registros residuais das tabelas legadas `solicitacoes` e `vagas_banca` para os módulos
 * - Remove 4 tabelas legadas/duplicadas (`solicitacoes`, `vagas_banca`, `sessions`, `migracoes_schema`)
 * - Remove colunas legadas/duplicadas de `configuracoes`, `bancas`, `examinadores`, `veiculos` e `instrutores`
 *
 * Sem BEGIN/COMMIT (o D1 gerencia a transação no batch/arquivo SQL).
 */
export const CLEANUP_V2_STATEMENTS: string[] = [
  // ── 1) Reconstrução de solicitacoes_cnhbrasil ───────────────────────────────
  `CREATE TABLE "solicitacoes_cnhbrasil_new" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "nome_candidato" TEXT,
    "nome_social" TEXT,
    "cpf" TEXT,
    "telefone" TEXT,
    "email" TEXT,
    "endereco" TEXT,
    "cidade" TEXT,
    "tipo_solicitacao" TEXT DEFAULT 'EXTRA',
    "tipo_exame" TEXT NOT NULL,
    "categoria_pretendida" TEXT DEFAULT 'B',
    "origem" TEXT NOT NULL,
    "curso_pratico_concluido" INTEGER DEFAULT 0 CHECK ("curso_pratico_concluido" IS NULL OR "curso_pratico_concluido" IN (0, 1)),
    "horas_praticas" INTEGER DEFAULT 0,
    "tem_veiculo" INTEGER DEFAULT 0 CHECK ("tem_veiculo" IS NULL OR "tem_veiculo" IN (0, 1)),
    "restricao_cnh" TEXT,
    "instrutor" TEXT,
    "modalidade_exame_a" TEXT,
    "modalidade_exame_b" TEXT,
    "placa_veiculo" TEXT,
    "sem_duplo_comando" INTEGER DEFAULT 0 CHECK ("sem_duplo_comando" IS NULL OR "sem_duplo_comando" IN (0, 1)),
    "checklist_veiculo" INTEGER DEFAULT 0 CHECK ("checklist_veiculo" IS NULL OR "checklist_veiculo" IN (0, 1)),
    "curso_pratico_inserido" INTEGER DEFAULT 0 CHECK ("curso_pratico_inserido" IS NULL OR "curso_pratico_inserido" IN (0, 1)),
    "taxa_paga" INTEGER DEFAULT 0 CHECK ("taxa_paga" IS NULL OR "taxa_paga" IN (0, 1)),
    "status" TEXT NOT NULL,
    "resultado" TEXT,
    "banca_id" TEXT,
    "data_agendada" TEXT,
    "hora_agendada" TEXT,
    "categoria_agendada" TEXT,
    "examinador_id" TEXT,
    "presenca_confirmada" INTEGER DEFAULT 0 CHECK ("presenca_confirmada" IS NULL OR "presenca_confirmada" IN (0, 1)),
    "motivo_cancelamento" TEXT,
    "observacao" TEXT,
    "historico_exames" TEXT DEFAULT '[]' CHECK ("historico_exames" IS NULL OR json_valid("historico_exames")),
    "modulo" TEXT,
    "cor_linha" TEXT,
    "criado_em" TEXT DEFAULT ${D1_NOW},
    "atualizado_em" TEXT DEFAULT ${D1_NOW},
    "fila_atualizado_em" TEXT,
    "agendado_por" TEXT
  )`,
  `INSERT INTO "solicitacoes_cnhbrasil_new" (${CNH_COLS})
   SELECT "id", "nome_candidato", "nome_social", "cpf", "telefone", "email", "endereco", "cidade",
          "tipo_solicitacao", "tipo_exame", "categoria_pretendida", "origem",
          "curso_pratico_concluido", "horas_praticas", "tem_veiculo", "restricao_cnh", "instrutor",
          "modalidade_exame_a", "modalidade_exame_b", "placa_veiculo", "sem_duplo_comando",
          "checklist_veiculo", "curso_pratico_inserido",
          CASE WHEN COALESCE("taxa_paga", 0) = 1 OR COALESCE("taxa_paga_bool", 0) = 1 THEN 1 ELSE 0 END,
          "status", "resultado", "banca_id", "data_agendada", "hora_agendada", "categoria_agendada",
          "examinador_id", "presenca_confirmada", "motivo_cancelamento", "observacao", "historico_exames",
          COALESCE(NULLIF("modulo", ''), 'CNH_BRASIL'),
          "cor_linha", "criado_em", "atualizado_em", "fila_atualizado_em", "agendado_por"
   FROM "solicitacoes_cnhbrasil"`,
  `INSERT OR IGNORE INTO "solicitacoes_cnhbrasil_new" (${CNH_COLS})
   SELECT "id", "nome_candidato", "nome_social", "cpf", "telefone", "email", "endereco", "cidade",
          "tipo_solicitacao", "tipo_exame", "categoria_pretendida", "origem",
          "curso_pratico_concluido", "horas_praticas", "tem_veiculo", "restricao_cnh", "instrutor",
          NULL, NULL, "placa_veiculo", "sem_duplo_comando",
          "checklist_veiculo", "curso_pratico_inserido",
          CASE WHEN COALESCE("taxa_paga", 0) = 1 OR COALESCE("taxa_paga_bool", 0) = 1 THEN 1 ELSE 0 END,
          "status", "resultado", "banca_id", "data_agendada", "hora_agendada", "categoria_agendada",
          "examinador_id", "presenca_confirmada", "motivo_cancelamento", "observacao", "historico_exames",
          'CNH_BRASIL',
          "cor_linha", "criado_em", "atualizado_em", "fila_atualizado_em", "agendado_por"
   FROM "solicitacoes"
   WHERE COALESCE("modulo", '') = 'CNH_BRASIL'
      OR (NULLIF("modulo", '') IS NULL AND COALESCE("tipo_exame", '') != 'PCD' AND ("autoescola_id" IS NULL OR "autoescola_id" = '' OR "autoescola_id" = 'CNH_BRASIL'))`,
  `DROP TABLE "solicitacoes_cnhbrasil"`,
  `ALTER TABLE "solicitacoes_cnhbrasil_new" RENAME TO "solicitacoes_cnhbrasil"`,
  `CREATE INDEX IF NOT EXISTS solicitacoes_cnhbrasil_banca_status ON solicitacoes_cnhbrasil (banca_id, status)`,

  // ── 2) Reconstrução de solicitacoes_cfc (apenas colunas do módulo CFC) ──────
  `CREATE TABLE "solicitacoes_cfc_new" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "tipo_solicitacao" TEXT DEFAULT 'EXTRA',
    "tipo_exame" TEXT NOT NULL,
    "categoria_pretendida" TEXT DEFAULT 'B',
    "origem" TEXT NOT NULL,
    "autoescola_id" TEXT,
    "status" TEXT NOT NULL,
    "resultado" TEXT,
    "banca_id" TEXT,
    "data_agendada" TEXT,
    "hora_agendada" TEXT,
    "categoria_agendada" TEXT,
    "examinador_id" TEXT,
    "presenca_confirmada" INTEGER DEFAULT 0 CHECK ("presenca_confirmada" IS NULL OR "presenca_confirmada" IN (0, 1)),
    "motivo_cancelamento" TEXT,
    "observacao" TEXT,
    "quantidades_categoria" TEXT CHECK ("quantidades_categoria" IS NULL OR json_valid("quantidades_categoria")),
    "examinadores_interessados" TEXT DEFAULT '[]' CHECK ("examinadores_interessados" IS NULL OR json_valid("examinadores_interessados")),
    "modulo" TEXT,
    "cor_linha" TEXT,
    "criado_em" TEXT DEFAULT ${D1_NOW},
    "atualizado_em" TEXT DEFAULT ${D1_NOW},
    "fila_atualizado_em" TEXT,
    "agendado_por" TEXT
  )`,
  `INSERT INTO "solicitacoes_cfc_new" (${CFC_COLS})
   SELECT "id", "tipo_solicitacao", "tipo_exame", "categoria_pretendida", "origem", "autoescola_id",
          "status", "resultado", "banca_id", "data_agendada", "hora_agendada", "categoria_agendada",
          "examinador_id", "presenca_confirmada", "motivo_cancelamento", "observacao",
          "quantidades_categoria", COALESCE("examinadores_interessados", '[]'),
          COALESCE(NULLIF("modulo", ''), 'CFC'),
          "cor_linha", "criado_em", "atualizado_em", "fila_atualizado_em", "agendado_por"
   FROM "solicitacoes_cfc"`,
  `INSERT OR IGNORE INTO "solicitacoes_cfc_new" (${CFC_COLS})
   SELECT "id", "tipo_solicitacao", "tipo_exame", "categoria_pretendida", "origem", "autoescola_id",
          "status", "resultado", "banca_id", "data_agendada", "hora_agendada", "categoria_agendada",
          "examinador_id", "presenca_confirmada", "motivo_cancelamento", "observacao",
          "quantidades_categoria", '[]',
          'CFC',
          "cor_linha", "criado_em", "atualizado_em", "fila_atualizado_em", "agendado_por"
   FROM "solicitacoes"
   WHERE COALESCE("modulo", '') = 'CFC'
      OR (NULLIF("modulo", '') IS NULL AND COALESCE("tipo_exame", '') != 'PCD' AND "autoescola_id" IS NOT NULL AND "autoescola_id" != '' AND "autoescola_id" NOT IN ('CNH_BRASIL', 'PCD'))`,
  `DROP TABLE "solicitacoes_cfc"`,
  `ALTER TABLE "solicitacoes_cfc_new" RENAME TO "solicitacoes_cfc"`,
  `CREATE INDEX IF NOT EXISTS solicitacoes_cfc_banca_status ON solicitacoes_cfc (banca_id, status)`,

  // ── 3) Reconstrução de solicitacoes_pcd ─────────────────────────────────────
  `CREATE TABLE "solicitacoes_pcd_new" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "nome_candidato" TEXT,
    "nome_social" TEXT,
    "cpf" TEXT,
    "telefone" TEXT,
    "email" TEXT,
    "endereco" TEXT,
    "cidade" TEXT,
    "tipo_solicitacao" TEXT DEFAULT 'EXTRA',
    "tipo_exame" TEXT NOT NULL,
    "categoria_pretendida" TEXT DEFAULT 'B',
    "origem" TEXT NOT NULL,
    "autoescola_id" TEXT,
    "curso_pratico_concluido" INTEGER DEFAULT 0 CHECK ("curso_pratico_concluido" IS NULL OR "curso_pratico_concluido" IN (0, 1)),
    "horas_praticas" INTEGER DEFAULT 0,
    "tem_veiculo" INTEGER DEFAULT 0 CHECK ("tem_veiculo" IS NULL OR "tem_veiculo" IN (0, 1)),
    "restricao_cnh" TEXT,
    "instrutor" TEXT,
    "placa_veiculo" TEXT,
    "checklist_veiculo" INTEGER DEFAULT 0 CHECK ("checklist_veiculo" IS NULL OR "checklist_veiculo" IN (0, 1)),
    "curso_pratico_inserido" INTEGER DEFAULT 0 CHECK ("curso_pratico_inserido" IS NULL OR "curso_pratico_inserido" IN (0, 1)),
    "taxa_paga" INTEGER DEFAULT 0 CHECK ("taxa_paga" IS NULL OR "taxa_paga" IN (0, 1)),
    "tipo_deficiencia" TEXT,
    "necessidades_especiais" TEXT,
    "status" TEXT NOT NULL,
    "resultado" TEXT,
    "banca_id" TEXT,
    "data_agendada" TEXT,
    "hora_agendada" TEXT,
    "categoria_agendada" TEXT,
    "examinador_id" TEXT,
    "presenca_confirmada" INTEGER DEFAULT 0 CHECK ("presenca_confirmada" IS NULL OR "presenca_confirmada" IN (0, 1)),
    "motivo_cancelamento" TEXT,
    "observacao" TEXT,
    "historico_exames" TEXT DEFAULT '[]' CHECK ("historico_exames" IS NULL OR json_valid("historico_exames")),
    "modulo" TEXT,
    "cor_linha" TEXT,
    "criado_em" TEXT DEFAULT ${D1_NOW},
    "atualizado_em" TEXT DEFAULT ${D1_NOW},
    "fila_atualizado_em" TEXT,
    "agendado_por" TEXT
  )`,
  `INSERT INTO "solicitacoes_pcd_new" (${PCD_COLS})
   SELECT "id", "nome_candidato", "nome_social", "cpf", "telefone", "email", "endereco", "cidade",
          "tipo_solicitacao", "tipo_exame", "categoria_pretendida", "origem", "autoescola_id",
          "curso_pratico_concluido", "horas_praticas", "tem_veiculo", "restricao_cnh", "instrutor",
          "placa_veiculo", "checklist_veiculo", "curso_pratico_inserido",
          CASE WHEN COALESCE("taxa_paga", 0) = 1 OR COALESCE("taxa_paga_bool", 0) = 1 THEN 1 ELSE 0 END,
          "tipo_deficiencia", "necessidades_especiais", "status", "resultado", "banca_id",
          "data_agendada", "hora_agendada", "categoria_agendada", "examinador_id",
          "presenca_confirmada", "motivo_cancelamento", "observacao", "historico_exames",
          COALESCE(NULLIF("modulo", ''), 'PCD'),
          "cor_linha", "criado_em", "atualizado_em", "fila_atualizado_em", "agendado_por"
   FROM "solicitacoes_pcd"`,
  `INSERT OR IGNORE INTO "solicitacoes_pcd_new" (${PCD_COLS})
   SELECT "id", "nome_candidato", "nome_social", "cpf", "telefone", "email", "endereco", "cidade",
          "tipo_solicitacao", "tipo_exame", "categoria_pretendida", "origem", "autoescola_id",
          "curso_pratico_concluido", "horas_praticas", "tem_veiculo", "restricao_cnh", "instrutor",
          "placa_veiculo", "checklist_veiculo", "curso_pratico_inserido",
          CASE WHEN COALESCE("taxa_paga", 0) = 1 OR COALESCE("taxa_paga_bool", 0) = 1 THEN 1 ELSE 0 END,
          "tipo_deficiencia", "necessidades_especiais", "status", "resultado", "banca_id",
          "data_agendada", "hora_agendada", "categoria_agendada", "examinador_id",
          "presenca_confirmada", "motivo_cancelamento", "observacao", "historico_exames",
          'PCD',
          "cor_linha", "criado_em", "atualizado_em", "fila_atualizado_em", "agendado_por"
   FROM "solicitacoes"
   WHERE COALESCE("modulo", '') = 'PCD' OR "tipo_exame" = 'PCD' OR "autoescola_id" = 'PCD'`,
  `DROP TABLE "solicitacoes_pcd"`,
  `ALTER TABLE "solicitacoes_pcd_new" RENAME TO "solicitacoes_pcd"`,
  `CREATE INDEX IF NOT EXISTS solicitacoes_pcd_banca_status ON solicitacoes_pcd (banca_id, status)`,

  // ── 4) Backfill seguro de vagas_banca -> vagas_cfc / vagas_pcd ─────────────
  `DROP TRIGGER IF EXISTS vagas_cfc_guard_insert`,
  `DROP TRIGGER IF EXISTS vagas_cfc_guard_update`,
  `INSERT OR IGNORE INTO "vagas_cfc" (${VAGA_COLS})
   SELECT "id", "autoescola_id", "tipo_exame", "tipo_solicitacao", "categoria_pretendida",
          "data_agendada", "hora_agendada", "examinador_id", "banca_id", "categoria_agendada",
          "status", "presenca_confirmada", "motivo_cancelamento", "observacao",
          NULL, "criado_em", "atualizado_em"
   FROM "vagas_banca"
   WHERE COALESCE("tipo_exame", '') != 'PCD'`,
  `INSERT OR IGNORE INTO "vagas_pcd" (${VAGA_COLS})
   SELECT "id", "autoescola_id", "tipo_exame", "tipo_solicitacao", "categoria_pretendida",
          "data_agendada", "hora_agendada", "examinador_id", "banca_id", "categoria_agendada",
          "status", "presenca_confirmada", "motivo_cancelamento", "observacao",
          NULL, "criado_em", "atualizado_em"
   FROM "vagas_banca"
   WHERE "tipo_exame" = 'PCD'`,

  // ── 5) Remover tabelas legadas e duplicadas ─────────────────────────────────
  `DROP TABLE IF EXISTS "solicitacoes"`,
  `DROP TABLE IF EXISTS "vagas_banca"`,
  `DROP TABLE IF EXISTS "sessions"`,
  `DROP TABLE IF EXISTS "migracoes_schema"`,

  // ── 6) Limpeza de colunas mortas em configuracoes (zapi_*) ──────────────────
  `CREATE TABLE "configuracoes_new" (
    "id" INTEGER PRIMARY KEY NOT NULL DEFAULT 1,
    "nome_orgao" TEXT DEFAULT 'DETRAN',
    "endereco_orgao" TEXT,
    "url_logo" TEXT,
    "modo_manutencao" INTEGER DEFAULT 0 CHECK ("modo_manutencao" IS NULL OR "modo_manutencao" IN (0, 1)),
    "min_dias_agendamento" INTEGER DEFAULT 2,
    "max_vagas_diarias" INTEGER DEFAULT 50,
    "max_vagas_a_padrao" INTEGER DEFAULT 10,
    "max_vagas_b_padrao" INTEGER DEFAULT 10,
    "max_vagas_mudanca_padrao" INTEGER DEFAULT 10,
    "template_whatsapp" TEXT,
    "template_whatsapp_cfc" TEXT,
    "endereco_exame_padrao" TEXT,
    "link_exame_padrao" TEXT,
    "restricoes" TEXT DEFAULT '[]' CHECK ("restricoes" IS NULL OR json_valid("restricoes")),
    "nome_exame_pcd" TEXT,
    "endereco_exame_pcd_padrao" TEXT,
    "link_exame_pcd_padrao" TEXT,
    "banca_principal_pcd" TEXT CHECK ("banca_principal_pcd" IS NULL OR json_valid("banca_principal_pcd")),
    "banca_principal_cnh_brasil" TEXT CHECK ("banca_principal_cnh_brasil" IS NULL OR json_valid("banca_principal_cnh_brasil")),
    "bloquear_fins_semana" INTEGER DEFAULT 0 CHECK ("bloquear_fins_semana" IS NULL OR "bloquear_fins_semana" IN (0, 1)),
    "chave_area_risco" TEXT,
    "ano_fabricacao_maximo" TEXT CHECK ("ano_fabricacao_maximo" IS NULL OR json_valid("ano_fabricacao_maximo")),
    "preencher_nome_cpf_cnh" INTEGER NOT NULL DEFAULT 0 CHECK ("preencher_nome_cpf_cnh" IS NULL OR "preencher_nome_cpf_cnh" IN (0, 1))
  )`,
  `INSERT INTO "configuracoes_new" ("id", "nome_orgao", "endereco_orgao", "url_logo", "modo_manutencao", "min_dias_agendamento", "max_vagas_diarias", "max_vagas_a_padrao", "max_vagas_b_padrao", "max_vagas_mudanca_padrao", "template_whatsapp", "template_whatsapp_cfc", "endereco_exame_padrao", "link_exame_padrao", "restricoes", "nome_exame_pcd", "endereco_exame_pcd_padrao", "link_exame_pcd_padrao", "banca_principal_pcd", "banca_principal_cnh_brasil", "bloquear_fins_semana", "chave_area_risco", "ano_fabricacao_maximo", "preencher_nome_cpf_cnh")
   SELECT "id", "nome_orgao", "endereco_orgao", "url_logo", "modo_manutencao", "min_dias_agendamento", "max_vagas_diarias", "max_vagas_a_padrao", "max_vagas_b_padrao", "max_vagas_mudanca_padrao", "template_whatsapp", "template_whatsapp_cfc", "endereco_exame_padrao", "link_exame_padrao", "restricoes", "nome_exame_pcd", "endereco_exame_pcd_padrao", "link_exame_pcd_padrao", "banca_principal_pcd", "banca_principal_cnh_brasil", "bloquear_fins_semana", "chave_area_risco", "ano_fabricacao_maximo", COALESCE("preencher_nome_cpf_cnh", 0)
   FROM "configuracoes"`,
  `DROP TABLE "configuracoes"`,
  `ALTER TABLE "configuracoes_new" RENAME TO "configuracoes"`,

  // ── 7) Limpeza de coluna duplicada em bancas (location_id -> local_id) ──────
  `CREATE TABLE "bancas_new" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "codigo" TEXT UNIQUE,
    "data" TEXT NOT NULL,
    "hora" TEXT NOT NULL,
    "examinadores_ids" TEXT DEFAULT '[]' CHECK ("examinadores_ids" IS NULL OR json_valid("examinadores_ids")),
    "max_vagas_a" INTEGER DEFAULT 10,
    "max_vagas_b" INTEGER DEFAULT 10,
    "tipo" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "motivo_cancelamento" TEXT,
    "local_id" TEXT,
    "criado_em" TEXT DEFAULT ${D1_NOW}
  )`,
  `INSERT INTO "bancas_new" ("id", "codigo", "data", "hora", "examinadores_ids", "max_vagas_a", "max_vagas_b", "tipo", "status", "motivo_cancelamento", "local_id", "criado_em")
   SELECT "id", "codigo", "data", "hora", "examinadores_ids", "max_vagas_a", "max_vagas_b", "tipo", "status", "motivo_cancelamento", COALESCE("local_id", "location_id"), "criado_em"
   FROM "bancas"`,
  `DROP TABLE "bancas"`,
  `ALTER TABLE "bancas_new" RENAME TO "bancas"`,

  // ── 8) Limpeza de colunas duplicadas em examinadores ────────────────────────
  `CREATE TABLE "examinadores_new" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "nome" TEXT NOT NULL,
    "matricula" TEXT NOT NULL,
    "pode_examinar_comum" INTEGER DEFAULT 1 CHECK ("pode_examinar_comum" IS NULL OR "pode_examinar_comum" IN (0, 1)),
    "pode_examinar_pcd" INTEGER DEFAULT 0 CHECK ("pode_examinar_pcd" IS NULL OR "pode_examinar_pcd" IN (0, 1)),
    "categorias" TEXT DEFAULT '[]' CHECK ("categorias" IS NULL OR json_valid("categorias")),
    "max_vagas_a_padrao" INTEGER,
    "max_vagas_b_padrao" INTEGER,
    "max_vagas_mudanca_padrao" INTEGER,
    "rodizio_provas" INTEGER NOT NULL DEFAULT 0 CHECK ("rodizio_provas" IS NULL OR "rodizio_provas" IN (0, 1)),
    "disponibilidade_rodizio" TEXT CHECK ("disponibilidade_rodizio" IS NULL OR json_valid("disponibilidade_rodizio")),
    "periodos_bloqueio" TEXT DEFAULT '[]' CHECK ("periodos_bloqueio" IS NULL OR json_valid("periodos_bloqueio")),
    "criado_em" TEXT DEFAULT ${D1_NOW}
  )`,
  `INSERT INTO "examinadores_new" ("id", "nome", "matricula", "pode_examinar_comum", "pode_examinar_pcd", "categorias", "max_vagas_a_padrao", "max_vagas_b_padrao", "max_vagas_mudanca_padrao", "rodizio_provas", "disponibilidade_rodizio", "periodos_bloqueio", "criado_em")
   SELECT "id", "nome", "matricula", "pode_examinar_comum", "pode_examinar_pcd",
          COALESCE("categorias", "categories", '[]'),
          COALESCE("max_vagas_a_padrao", "default_max_slots_a"),
          COALESCE("max_vagas_b_padrao", "default_max_slots_b"),
          COALESCE("max_vagas_mudanca_padrao", "default_max_slots_mudanca"),
          "rodizio_provas", "disponibilidade_rodizio",
          COALESCE("periodos_bloqueio", '[]'), "criado_em"
   FROM "examinadores"`,
  `DROP TABLE "examinadores"`,
  `ALTER TABLE "examinadores_new" RENAME TO "examinadores"`,

  // ── 9) Limpeza de ano_modelo em veiculos ────────────────────────────────────
  `CREATE TABLE "veiculos_new" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "instrutor_id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "marca" TEXT NOT NULL,
    "modelo" TEXT NOT NULL,
    "placa" TEXT NOT NULL,
    "ativo" INTEGER DEFAULT 1 CHECK ("ativo" IS NULL OR "ativo" IN (0, 1)),
    "transmissao" TEXT,
    "acessorios" TEXT DEFAULT '[]' CHECK ("acessorios" IS NULL OR json_valid("acessorios")),
    "duplo_comando" INTEGER DEFAULT 0 CHECK ("duplo_comando" IS NULL OR "duplo_comando" IN (0, 1)),
    "procuracao" INTEGER DEFAULT 0 CHECK ("procuracao" IS NULL OR "procuracao" IN (0, 1)),
    "ano_fabricacao" TEXT,
    "criado_em" TEXT DEFAULT ${D1_NOW}
  )`,
  `INSERT INTO "veiculos_new" ("id", "instrutor_id", "tipo", "marca", "modelo", "placa", "ativo", "transmissao", "acessorios", "duplo_comando", "procuracao", "ano_fabricacao", "criado_em")
   SELECT "id", "instrutor_id", "tipo", "marca", "modelo", "placa", "ativo", "transmissao", "acessorios", "duplo_comando", "procuracao", COALESCE("ano_fabricacao", "ano_modelo"), "criado_em"
   FROM "veiculos"`,
  `DROP TABLE "veiculos"`,
  `ALTER TABLE "veiculos_new" RENAME TO "veiculos"`,

  // ── 10) Limpeza de cpf_hash em instrutores ──────────────────────────────────
  `CREATE TABLE "instrutores_new" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "nome" TEXT NOT NULL,
    "cpf" TEXT NOT NULL,
    "telefone" TEXT,
    "categoria" TEXT,
    "placa" TEXT,
    "criado_em" TEXT DEFAULT ${D1_NOW}
  )`,
  `INSERT INTO "instrutores_new" ("id", "nome", "cpf", "telefone", "categoria", "placa", "criado_em")
   SELECT "id", "nome", "cpf", "telefone", "categoria", "placa", "criado_em"
   FROM "instrutores"`,
  `DROP TABLE "instrutores"`,
  `ALTER TABLE "instrutores_new" RENAME TO "instrutores"`,

  // ── 11) Recriar triggers de vagas_cfc após reconstrução de examinadores ─────
  ...VAGAS_CFC_TRIGGERS,
];

export async function cleanupV2Checksum(): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(CLEANUP_V2_STATEMENTS.join(';\n')));
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
}

export async function migrateCleanupV2D1(binding: D1Database): Promise<void> {
  const checksum = await cleanupV2Checksum();
  const applied = await binding.prepare('SELECT checksum FROM migracoes_d1 WHERE versao = ?')
    .bind(CLEANUP_V2_VERSION).first<{ checksum: string }>();
  if (applied) {
    if (applied.checksum !== checksum) {
      throw new Error('Migração D1 de reorganização (v2) modificada após aplicada.');
    }
    return;
  }
  await binding.batch([
    ...CLEANUP_V2_STATEMENTS.map(s => binding.prepare(s)),
    binding.prepare('INSERT INTO migracoes_d1 (versao, checksum, aplicado_em) VALUES (?, ?, ?)')
      .bind(CLEANUP_V2_VERSION, checksum, new Date().toISOString()),
  ]);
}
