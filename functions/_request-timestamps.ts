/**
 * Converte timestamps opcionais recebidos via JSON (string ISO, number, Date, null)
 * em Date | null para colunas timestamp do Drizzle ORM sem lançar TypeError/RangeError.
 */
export function coerceOptionalTimestamp(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const normalized = typeof value === 'string' ? value.trim() : value;
    if (normalized === '') return null;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
