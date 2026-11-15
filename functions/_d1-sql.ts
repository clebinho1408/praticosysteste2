import { d1Tables, D1_NOW } from '../db/d1-schema.js';

// Deliberately a small compatibility dialect for this app, not a PostgreSQL
// emulator. Never modify literals/quoted identifiers or interpolate user input.
const tokens = /'(?:''|[^'])*'|"(?: ""|""|[^"])*"|\$\d+|[a-z_][a-z_0-9]*|\s+|./gis;
function targetTableName(source: string): string | null {
  const selectMatch = /^\s*select\b[\s\S]*?\bfrom\s+"([^"]+)"/i.exec(source);
  if (selectMatch) return selectMatch[1];
  const insertMatch = /^\s*insert\s+into\s+"([^"]+)"/i.exec(source);
  if (insertMatch) return insertMatch[1];
  const updateMatch = /^\s*update\s+"([^"]+)"/i.exec(source);
  if (updateMatch) return updateMatch[1];
  return null;
}

function stripMissingCpfHmacProjection(pieces: string[]): string[] {
  const out: string[] = [];
  let depth = 0;
  let inSelectList = false;
  let inReturningList = false;

  for (let i = 0; i < pieces.length; i++) {
    const token = pieces[i];
    if (token === '(') {
      depth++;
      out.push(token);
      continue;
    }
    if (token === ')' && depth > 0) {
      depth--;
      out.push(token);
      continue;
    }

    if (depth === 0) {
      if (/^select$/i.test(token) && out.every(t => /^\s*$/.test(t))) {
        inSelectList = true;
        out.push(token);
        continue;
      }
      if (inSelectList && /^from$/i.test(token)) {
        inSelectList = false;
        out.push(token);
        continue;
      }
      if (/^returning$/i.test(token)) {
        inReturningList = true;
        out.push(token);
        continue;
      }
    }

    if ((inSelectList || inReturningList) && depth === 0) {
      // "table"."cpf_hmac"
      if (
        /^"[^"]+"$/.test(token) &&
        pieces[i + 1] === '.' &&
        pieces[i + 2]?.toLowerCase() === '"cpf_hmac"'
      ) {
        let j = i + 3;
        while (j < pieces.length && /^\s+$/.test(pieces[j])) j++;
        out.push(/^as$/i.test(pieces[j] ?? '') ? 'NULL' : 'NULL AS "cpf_hmac"');
        i += 2;
        continue;
      }
      // "cpf_hmac"
      if (token.toLowerCase() === '"cpf_hmac"') {
        let j = i + 1;
        while (j < pieces.length && /^\s+$/.test(pieces[j])) j++;
        out.push(/^as$/i.test(pieces[j] ?? '') ? 'NULL' : 'NULL AS "cpf_hmac"');
        continue;
      }
    }

    out.push(token);
  }
  return out;
}

export function translateD1Sql(
  source: string,
  params: unknown[],
  options?: { missingCpfHmacTables?: ReadonlySet<string> },
) {
  if (/\b(DO\s+\$|information_schema|INCLUDING\s+ALL|ILIKE|JSONB_SET)\b/i.test(source)) {
    throw new Error('SQL PostgreSQL não suportado no D1; use a migração ou uma consulta D1 explícita.');
  }
  const missingTables = options?.missingCpfHmacTables;
  // Drizzle Pg emits DEFAULT values for omitted columns. SQLite requires an
  // expression instead; defaults come from the same table metadata.
  const insert = /^\s*insert\s+into\s+"([^"]+)"\s*\(([^)]+)\)\s*values\s*/i.exec(source);
  if (insert) {
    const columns = [...insert[2].matchAll(/"([^"]+)"/g)].map(m => m[1]);
    const defaults = d1Tables[insert[1]];
    if (!defaults) throw new Error('Tabela D1 desconhecida.');
    const stripHmacIdx = missingTables?.has(insert[1]) ? columns.indexOf('cpf_hmac') : -1;
    const keptColumns = stripHmacIdx >= 0 ? columns.filter((_, idx) => idx !== stripHmacIdx) : columns;
    const header = stripHmacIdx >= 0
      ? `insert into "${insert[1]}" (${keptColumns.map(c => `"${c}"`).join(', ')}) values `
      : insert[0];

    const suffixTokens = source.slice(insert[0].length).match(tokens) ?? [];
    const rebuilt: string[] = [];
    let idx = 0;
    let expectTuple = true;
    while (idx < suffixTokens.length) {
      const tok = suffixTokens[idx];
      if (expectTuple && tok === '(') {
        let depth = 1;
        idx++;
        const fields: string[][] = [[]];
        while (idx < suffixTokens.length && depth > 0) {
          const inner = suffixTokens[idx++];
          if (inner === '(') {
            depth++;
            fields[fields.length - 1].push(inner);
          } else if (inner === ')') {
            depth--;
            if (depth > 0) fields[fields.length - 1].push(inner);
          } else if (inner === ',' && depth === 1) {
            fields.push([]);
          } else {
            fields[fields.length - 1].push(inner);
          }
        }
        const keptFields = stripHmacIdx >= 0 && fields.length === columns.length
          ? fields.filter((_, fIdx) => fIdx !== stripHmacIdx)
          : fields;
        const formattedFields = keptFields.map((fieldTokens, colIdx) => {
          const colDef = defaults.find(c => c.name === keptColumns[colIdx]);
          return fieldTokens.map(t => (/^default$/i.test(t) ? (colDef?.defaultSql ?? 'NULL') : t)).join('');
        });
        rebuilt.push(`(${formattedFields.join(',')})`);
        let look = idx;
        while (look < suffixTokens.length && /^\s+$/.test(suffixTokens[look])) look++;
        expectTuple = suffixTokens[look] === ',';
        continue;
      }
      rebuilt.push(tok);
      idx++;
    }
    source = header + rebuilt.join('');
  }
  let pieces: string[] = source.match(tokens) ?? [];
  if (missingTables && missingTables.size > 0 && /"cpf_hmac"/i.test(source)) {
    const tableName = targetTableName(source);
    if (tableName && missingTables.has(tableName)) {
      pieces = stripMissingCpfHmacProjection(pieces);
    }
  }
  const bound: unknown[] = [];
  let output = '';
  for (let i = 0; i < pieces.length; i++) {
    const token = pieces[i];
    if (/^\$\d+$/.test(token)) {
      const value = params[Number(token.slice(1)) - 1];
      bound.push(value instanceof Date ? value.toISOString() : typeof value === 'boolean' ? Number(value) : value ?? null);
      output += '?';
    } else if (/^now$/i.test(token) && pieces[i + 1] === '(' && pieces[i + 2] === ')') {
      output += D1_NOW; i += 2;
    } else if (token === ':' && pieces[i + 1] === ':' && /^jsonb$/i.test(pieces[i + 2])) {
      i += 2;
    } else if (token === ':' && pieces[i + 1] === ':' && /^date$/i.test(pieces[i + 2])) {
      const identifier = /("[^"]+"|[a-z_][a-z_0-9]*)$/i.exec(output);
      if (!identifier) throw new Error('Conversão de data D1 não suportada.');
      output = output.slice(0, -identifier[0].length) + `date(${identifier[0]})`; i += 2;
    } else if (/^public$/i.test(token) && pieces[i + 1] === '.') {
      i++;
    } else {
      output += token;
    }
  }
  if (bound.length > 100 || new TextEncoder().encode(output).length > 100_000) {
    throw new Error('Consulta excede os limites D1 (100 parâmetros / 100 KB). Use um lote atômico.');
  }
  for (const value of bound) {
    if (typeof value === 'string' && new TextEncoder().encode(value).length > 1_900_000) {
      throw new Error('Valor excede o limite de registro D1. Divida o conteúdo antes de gravar.');
    }
  }
  return { sql: output, params: bound };
}

const kinds = new Map(Object.values(d1Tables).flatMap(cols => cols.map(c => [c.name, c.kind] as const)));
const aliases: Record<string, string> = {
  name: 'nome', role: 'perfil', force_password_change: 'forcar_troca_senha',
  allowed_modules: 'modulos_permitidos', allowed_location_ids: 'locais_permitidos_ids',
  two_factor_enabled: 'dois_fatores_ativo', payload: 'dados', details: 'detalhes',
};
export function decodeD1Row(row: Record<string, unknown>, arrayMode = false) {
  const entries = Object.entries(row).map(([key, value]) => {
    const kind = kinds.get(aliases[key] ?? key);
    if (value != null && kind === 'boolean') value = value === 1 || value === true;
    if (typeof value === 'string' && kind === 'json') value = JSON.parse(value);
    // PgTimestamp's mapper appends +0000. Only array mode is ORM-mapped.
    if (typeof value === 'string' && kind === 'timestamp' && arrayMode) value = value.replace(/Z$/, '');
    return [key, value] as const;
  });
  return arrayMode ? entries.map(([, v]) => v) : Object.fromEntries(entries);
}
