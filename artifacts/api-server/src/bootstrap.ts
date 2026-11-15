import { db, isInMemoryDb, users, systemSettings } from "@workspace/db";
import { sql } from "drizzle-orm";
import crypto from "crypto";
import { hashPassword } from "./password";
import { logger } from "./lib/logger";

export async function ensureInMemoryBaseSchema(): Promise<void> {
  if (!isInMemoryDb) return;

  const ddlStatements = [
    `CREATE TABLE IF NOT EXISTS usuarios (
      id text PRIMARY KEY,
      nome text NOT NULL,
      login text NOT NULL UNIQUE,
      senha text,
      perfil text NOT NULL,
      autoescola_id text,
      examinador_id text,
      instrutor_id text,
      forcar_troca_senha boolean DEFAULT true,
      modulos_permitidos jsonb DEFAULT '[]'::jsonb,
      locais_permitidos_ids jsonb DEFAULT '[]'::jsonb,
      abas_cadastro_permitidas jsonb DEFAULT '[]'::jsonb,
      email text,
      telefone text,
      dois_fatores_ativo boolean DEFAULT false,
      criado_em timestamp DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS codigos_otp (
      id text PRIMARY KEY,
      usuario_id text NOT NULL,
      codigo text NOT NULL,
      expira_em timestamp NOT NULL,
      usado boolean DEFAULT false,
      tentativas_falhas integer DEFAULT 0,
      criado_em timestamp DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS autoescolas (
      id text PRIMARY KEY,
      nome text NOT NULL,
      telefone text,
      email text,
      endereco text,
      cidade text,
      servicos jsonb DEFAULT '[]'::jsonb,
      nao_criar_usuario boolean NOT NULL DEFAULT false,
      rodizio_provas boolean NOT NULL DEFAULT false,
      perfil_cnh_brasil boolean NOT NULL DEFAULT false,
      endereco_patio_moto text,
      endereco_patio_carro text,
      endereco_patio_mudanca text,
      patios jsonb DEFAULT '[]'::jsonb,
      banca_principal jsonb,
      banca_provisoria jsonb,
      criado_em timestamp DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS examinadores (
      id text PRIMARY KEY,
      nome text NOT NULL,
      matricula text NOT NULL,
      pode_examinar_comum boolean DEFAULT true,
      pode_examinar_pcd boolean DEFAULT false,
      categorias jsonb DEFAULT '[]'::jsonb,
      max_vagas_a_padrao integer,
      max_vagas_b_padrao integer,
      max_vagas_mudanca_padrao integer,
      rodizio_provas boolean NOT NULL DEFAULT false,
      disponibilidade_rodizio jsonb,
      periodos_bloqueio jsonb DEFAULT '[]'::jsonb,
      criado_em timestamp DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS instrutores (
      id text PRIMARY KEY,
      nome text NOT NULL,
      cpf text NOT NULL,
      telefone text,
      categoria text,
      placa text,
      criado_em timestamp DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS veiculos (
      id text PRIMARY KEY,
      instrutor_id text NOT NULL,
      tipo text NOT NULL,
      marca text NOT NULL,
      model text,
      modelo text NOT NULL,
      placa text NOT NULL,
      ativo boolean DEFAULT true,
      transmissao text,
      acessorios jsonb DEFAULT '[]'::jsonb,
      duplo_comando boolean DEFAULT false,
      procuracao boolean DEFAULT false,
      ano_fabricacao text,
      criado_em timestamp DEFAULT now()
    )`,
    `ALTER TABLE veiculos DROP COLUMN IF EXISTS model`,
    `CREATE TABLE IF NOT EXISTS locais_exame (
      id text PRIMARY KEY,
      cidade_id text NOT NULL,
      endereco text,
      url_maps text,
      regioes_atendidas jsonb DEFAULT '[]'::jsonb,
      criado_em timestamp DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS bancas (
      id text PRIMARY KEY,
      codigo text UNIQUE,
      data text NOT NULL,
      hora text NOT NULL,
      examinadores_ids jsonb DEFAULT '[]'::jsonb,
      max_vagas_a integer DEFAULT 10,
      max_vagas_b integer DEFAULT 10,
      tipo text NOT NULL,
      status text NOT NULL,
      motivo_cancelamento text,
      local_id text,
      criado_em timestamp DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS solicitacoes (
      id text PRIMARY KEY,
      nome_candidato text,
      nome_social text,
      cpf text,
      telefone text,
      email text,
      endereco text,
      cidade text,
      tipo_solicitacao text DEFAULT 'EXTRA',
      tipo_exame text NOT NULL,
      categoria_pretendida text DEFAULT 'B',
      origem text NOT NULL,
      autoescola_id text,
      taxa_paga_bool boolean DEFAULT false,
      curso_pratico_concluido boolean DEFAULT false,
      horas_praticas integer DEFAULT 0,
      tem_veiculo boolean DEFAULT false,
      restricao_cnh text,
      instrutor text,
      placa_veiculo text,
      sem_duplo_comando boolean DEFAULT false,
      checklist_veiculo boolean DEFAULT false,
      curso_pratico_inserido boolean DEFAULT false,
      taxa_paga boolean DEFAULT false,
      tipo_deficiencia text,
      necessidades_especiais text,
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
      quantidades_categoria jsonb,
      historico_exames jsonb DEFAULT '[]'::jsonb,
      modulo text,
      cor_linha text,
      criado_em timestamp DEFAULT now(),
      atualizado_em timestamp DEFAULT now(),
      fila_atualizado_em timestamp,
      agendado_por text
    )`,
    `CREATE TABLE IF NOT EXISTS configuracoes (
      id integer PRIMARY KEY DEFAULT 1,
      nome_orgao text DEFAULT 'DETRAN',
      endereco_orgao text,
      url_logo text,
      modo_manutencao boolean DEFAULT false,
      min_dias_agendamento integer DEFAULT 2,
      max_vagas_diarias integer DEFAULT 50,
      max_vagas_a_padrao integer DEFAULT 10,
      max_vagas_b_padrao integer DEFAULT 10,
      max_vagas_mudanca_padrao integer DEFAULT 10,
      template_whatsapp text,
      template_whatsapp_cfc text,
      endereco_exame_padrao text,
      link_exame_padrao text,
      restricoes jsonb DEFAULT '[]'::jsonb,
      nome_exame_pcd text,
      endereco_exame_pcd_padrao text,
      link_exame_pcd_padrao text,
      banca_principal_pcd jsonb,
      banca_principal_cnh_brasil jsonb,
      bloquear_fins_semana boolean DEFAULT false,
      chave_area_risco text,
      ano_fabricacao_maximo jsonb,
      preencher_nome_cpf_cnh boolean NOT NULL DEFAULT false
    )`,
    `CREATE TABLE IF NOT EXISTS cotas_consulta_cpf (
      id text PRIMARY KEY,
      janela_minuto integer NOT NULL,
      consultas integer NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS logs_auditoria (
      id text PRIMARY KEY,
      usuario_id text,
      nome_usuario text,
      perfil_usuario text,
      acao text NOT NULL,
      entidade text NOT NULL,
      entidade_id text,
      detalhes jsonb,
      criado_em timestamp DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS datas_bloqueadas (
      id text PRIMARY KEY,
      data text NOT NULL,
      descricao text,
      feriado boolean DEFAULT false,
      criado_em timestamp DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS cidades (
      id text PRIMARY KEY,
      nome text NOT NULL UNIQUE,
      criado_em timestamp DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS vagas_banca (
      id text PRIMARY KEY,
      autoescola_id text NOT NULL,
      tipo_exame text NOT NULL,
      tipo_solicitacao text NOT NULL,
      categoria_pretendida text,
      data_agendada text,
      hora_agendada text,
      examinador_id text,
      banca_id text,
      categoria_agendada text,
      status text NOT NULL DEFAULT 'SCHEDULED',
      presenca_confirmada boolean DEFAULT false,
      motivo_cancelamento text,
      observacao text,
      criado_em timestamp DEFAULT now(),
      atualizado_em timestamp DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS resultados_banca (
      id text PRIMARY KEY,
      banca_id text NOT NULL,
      autoescola_id text NOT NULL,
      categoria text NOT NULL,
      total_vagas integer DEFAULT 0,
      vagas_usadas integer DEFAULT 0,
      aprovados integer DEFAULT 0,
      reprovados integer DEFAULT 0,
      ausentes integer DEFAULT 0,
      cancelados integer DEFAULT 0,
      modulo text,
      criado_em timestamp DEFAULT now(),
      atualizado_em timestamp DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS sessoes (
      id text PRIMARY KEY,
      usuario_id text NOT NULL,
      expira_em timestamp NOT NULL,
      criado_em timestamp DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS backups (
      id text PRIMARY KEY,
      tipo_gatilho text NOT NULL DEFAULT 'manual',
      dados jsonb NOT NULL,
      tamanho_bytes integer DEFAULT 0,
      criado_em timestamp DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS migracoes_schema (
      versao text PRIMARY KEY,
      aplicado_em timestamp DEFAULT now()
    )`,
  ];

  for (const stmt of ddlStatements) {
    await db.execute(sql.raw(stmt));
  }

  // Marca renomeação como aplicada no banco novo em memória
  await db.execute(
    sql`INSERT INTO migracoes_schema (versao) VALUES ('pt_schema_v1') ON CONFLICT DO NOTHING`,
  );

  logger.info("In-memory PGlite base schema initialized");
}

export async function seedInMemoryDefaults(): Promise<void> {
  if (!isInMemoryDb) return;

  const existingSettings = await db.select().from(systemSettings).limit(1);
  if (existingSettings.length === 0) {
    await db
      .insert(systemSettings)
      .values({ id: 1, agencyName: "DETRAN" })
      .onConflictDoNothing();
  }

  const existingUsers = await db.select().from(users).limit(1);
  if (existingUsers.length === 0) {
    await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        name: "Administrador",
        login: "admin",
        password: await hashPassword("admin123"),
        role: "ADMIN",
        forcePasswordChange: false,
        allowedModules: ["cnh", "cfc", "pcd"],
      })
      .onConflictDoNothing();
    logger.info("Seeded in-memory default admin user (login: admin)");
  }
}
