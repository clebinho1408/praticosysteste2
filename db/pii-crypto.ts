// Criptografia em nível de aplicação (AES-256-GCM) e índice cego (HMAC-SHA256)
// usando exclusivamente Web Crypto API (compatível com Cloudflare Workers e Node 22+).

export const ENCRYPTED_PREFIX = 'enc:v1:';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type PiiCryptoEnv = {
  DATA_ENCRYPTION_KEY?: string;
  CPF_HMAC_KEY?: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function resolve32ByteKey(secret: string): Promise<Uint8Array> {
  const trimmed = secret.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  if (/^[A-Za-z0-9+/=]{43,44}$/.test(trimmed)) {
    try {
      const decoded = base64ToBytes(trimmed);
      if (decoded.length === 32) return decoded;
    } catch {}
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(trimmed));
  return new Uint8Array(digest);
}

async function importAesKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const raw = await resolve32ByteKey(secret);
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, usage);
}

async function importHmacKey(env?: PiiCryptoEnv): Promise<CryptoKey | null> {
  const explicit = env?.CPF_HMAC_KEY?.trim();
  if (explicit) {
    const raw = await resolve32ByteKey(explicit);
    return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  const master = env?.DATA_ENCRYPTION_KEY?.trim();
  if (!master) return null;
  // Derivação separada por domínio para nunca reutilizar a chave AES diretamente no HMAC
  const masterRaw = await resolve32ByteKey(master);
  const baseKey = await crypto.subtle.importKey('raw', masterRaw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', baseKey, encoder.encode('praticosys:cpf-hmac:v1'));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export function isEncryptedValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

export function cleanCpfDigits(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\D/g, '') : '';
}

export function maskCpf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  if (value.startsWith(ENCRYPTED_PREFIX)) return '***.***.***-**';
  if (value.includes('*')) return value;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11) {
    return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
  }
  if (digits.length >= 4) {
    return `***.***.*${digits.slice(-2)}`;
  }
  return '***';
}

export async function encryptField(value: unknown, env?: PiiCryptoEnv): Promise<any> {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value !== 'string') return value;
  if (isEncryptedValue(value)) return value;
  const secret = env?.DATA_ENCRYPTION_KEY?.trim();
  if (!secret) return value;

  const key = await importAesKey(secret, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(value),
  );
  return `${ENCRYPTED_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(cipherBuffer))}`;
}

export async function decryptField(value: unknown, env?: PiiCryptoEnv): Promise<any> {
  if (value === null || value === undefined || value === '') return value;
  if (!isEncryptedValue(value)) return value;
  const secret = env?.DATA_ENCRYPTION_KEY?.trim();
  if (!secret) {
    throw new Error('Chave DATA_ENCRYPTION_KEY não configurada para descriptografar dados sensíveis.');
  }
  const rest = value.slice(ENCRYPTED_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) throw new Error('Valor criptografado inválido.');
  const iv = base64ToBytes(rest.slice(0, sep));
  const ciphertext = base64ToBytes(rest.slice(sep + 1));
  const key = await importAesKey(secret, ['decrypt']);
  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return decoder.decode(plainBuffer);
}

export async function decryptFieldSafe(value: unknown, env?: PiiCryptoEnv): Promise<any> {
  if (!isEncryptedValue(value)) return value;
  try {
    return await decryptField(value, env);
  } catch (err) {
    console.error('[pii-crypto] Falha ao descriptografar campo:', err);
    return value;
  }
}

export async function computeCpfHmac(cpf: unknown, env?: PiiCryptoEnv): Promise<string | null> {
  const digits = cleanCpfDigits(cpf);
  if (!digits) return null;
  const key = await importHmacKey(env);
  if (!key) return null;
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(digits));
  return bytesToHex(new Uint8Array(sig));
}

const REQUEST_PII_FIELDS = ['cpf', 'phone', 'email', 'address'] as const;
const INSTRUCTOR_PII_FIELDS = ['cpf', 'phone'] as const;

export type PiiEncryptOptions = { includeCpfHmac?: boolean };

export async function encryptRequestPii<T extends Record<string, any>>(
  row: T,
  env?: PiiCryptoEnv,
  options?: PiiEncryptOptions,
): Promise<T> {
  const out: Record<string, any> = { ...row };
  const includeCpfHmac = options?.includeCpfHmac ?? true;
  if (includeCpfHmac && out.cpf !== undefined) {
    const plainCpf = isEncryptedValue(out.cpf) ? await decryptField(out.cpf, env) : out.cpf;
    out.cpfHmac = plainCpf ? await computeCpfHmac(plainCpf, env) : null;
  } else if (!includeCpfHmac) {
    delete out.cpfHmac;
  }
  for (const field of REQUEST_PII_FIELDS) {
    if (out[field] !== undefined) out[field] = await encryptField(out[field], env);
  }
  return out as T;
}

export async function decryptRequestPii<T extends Record<string, any> | null | undefined>(row: T, env?: PiiCryptoEnv): Promise<T> {
  if (!row || typeof row !== 'object') return row;
  const out: Record<string, any> = { ...row };
  for (const field of REQUEST_PII_FIELDS) {
    if (out[field] !== undefined) out[field] = await decryptField(out[field], env);
  }
  delete out.cpfHmac;
  return out as T;
}

export async function decryptRequestPiiSafe<T extends Record<string, any> | null | undefined>(row: T, env?: PiiCryptoEnv): Promise<T> {
  if (!row || typeof row !== 'object') return row;
  const out: Record<string, any> = { ...row };
  for (const field of REQUEST_PII_FIELDS) {
    if (out[field] !== undefined) out[field] = await decryptFieldSafe(out[field], env);
  }
  delete out.cpfHmac;
  return out as T;
}

export async function encryptInstructorPii<T extends Record<string, any>>(
  row: T,
  env?: PiiCryptoEnv,
  options?: PiiEncryptOptions,
): Promise<T> {
  const out: Record<string, any> = { ...row };
  const includeCpfHmac = options?.includeCpfHmac ?? true;
  if (includeCpfHmac && out.cpf !== undefined) {
    const plainCpf = isEncryptedValue(out.cpf) ? await decryptField(out.cpf, env) : out.cpf;
    out.cpfHmac = plainCpf ? await computeCpfHmac(plainCpf, env) : null;
  } else if (!includeCpfHmac) {
    delete out.cpfHmac;
  }
  for (const field of INSTRUCTOR_PII_FIELDS) {
    if (out[field] !== undefined) out[field] = await encryptField(out[field], env);
  }
  return out as T;
}

export async function decryptInstructorPii<T extends Record<string, any> | null | undefined>(row: T, env?: PiiCryptoEnv): Promise<T> {
  if (!row || typeof row !== 'object') return row;
  const out: Record<string, any> = { ...row };
  for (const field of INSTRUCTOR_PII_FIELDS) {
    if (out[field] !== undefined) out[field] = await decryptField(out[field], env);
  }
  delete out.cpfHmac;
  return out as T;
}

export async function decryptInstructorPiiSafe<T extends Record<string, any> | null | undefined>(row: T, env?: PiiCryptoEnv): Promise<T> {
  if (!row || typeof row !== 'object') return row;
  const out: Record<string, any> = { ...row };
  for (const field of INSTRUCTOR_PII_FIELDS) {
    if (out[field] !== undefined) out[field] = await decryptFieldSafe(out[field], env);
  }
  delete out.cpfHmac;
  return out as T;
}

export function maskAuditDetails<T extends Record<string, any> | null | undefined>(details: T): T {
  if (!details || typeof details !== 'object') return details;
  if (!Object.hasOwn(details, 'cpf')) return details;
  return {
    ...details,
    cpf: details.cpf ? maskCpf(details.cpf) : null,
  };
}
