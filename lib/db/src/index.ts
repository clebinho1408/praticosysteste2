import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// No Replit, DATABASE_URL é gerenciada pela plataforma. Quando o projeto usa
// um Neon externo, DATA_BASE_NEON mantém a prévia e o ambiente publicado na
// mesma base de dados. Sem URL configurada, usa PGlite em memória.
const connectionString = process.env.DATA_BASE_NEON || process.env.DATABASE_URL;

export const isInMemoryDb = !connectionString;
export const pool = connectionString ? new Pool({ connectionString }) : null;
export const pgliteClient = !connectionString ? new PGlite() : null;
export const db: ReturnType<typeof drizzlePg<typeof schema>> = (
  connectionString
    ? drizzlePg(pool!, { schema })
    : drizzlePglite(pgliteClient!, { schema })
) as any;

export * from "./schema";
