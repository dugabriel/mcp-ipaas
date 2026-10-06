import type { SessionCookie } from "../model/types.js";

const JWT_COOKIE = "jwt.token";
const STORAGE_KEY_HINTS = ["authtoken", "bearer"];

function hasText(value: string | undefined | null): value is string {
  return !!value && value.trim() !== "";
}

/**
 * Resolve o token corrente a partir do que foi observado no navegador (logica pura).
 * Prefere o cookie jwt.token; cai para o storage procurando chaves que contenham
 * authToken/Bearer. Reflete a empresa selecionada no instante da leitura.
 */
export function extractToken(
  cookies: SessionCookie[] | null | undefined,
  storage: Record<string, string> | null | undefined,
): string | undefined {
  const fromCookie = (cookies ?? []).find((c) => c.name === JWT_COOKIE)?.value;
  if (hasText(fromCookie)) return fromCookie;

  for (const [key, value] of Object.entries(storage ?? {})) {
    const normalized = key.toLowerCase();
    if (STORAGE_KEY_HINTS.some((hint) => normalized.includes(hint)) && hasText(value)) {
      return value;
    }
  }
  return undefined;
}
