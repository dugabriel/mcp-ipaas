const VISIBLE_EDGE = 4;
const ELLIPSIS = "\u2026";
const FULLY_MASKED = "****";

/**
 * Mascara um token para registro em log: preserva no maximo as pontas (ex.: abcd…wxyz)
 * e nunca revela o token inteiro. Tokens curtos/vazios viram um marcador neutro.
 */
export function maskToken(token: string | null | undefined): string {
  if (!token || token.length <= VISIBLE_EDGE * 2) return FULLY_MASKED;
  return token.slice(0, VISIBLE_EDGE) + ELLIPSIS + token.slice(-VISIBLE_EDGE);
}
