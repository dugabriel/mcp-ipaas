/** Conteudo de resposta de uma tool MCP (texto). */
export interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>;
  [key: string]: unknown;
}

function text(value: string): ToolTextResult {
  return { content: [{ type: "text", text: value }] };
}

/** Serializa um objeto como JSON legivel no formato de resposta de tool. */
export function jsonResponse(value: unknown): ToolTextResult {
  try {
    return text(JSON.stringify(value, null, 2));
  } catch (err) {
    return errorResponse("Failed to serialize response as JSON", err);
  }
}

/** Mensagem amigavel quando falta sessao ativa; orienta chamar iniciar_login_ipaas. */
export function missingSession(): ToolTextResult {
  return jsonResponse({
    state: "AUSENTE",
    message:
      "Nenhuma sessao ativa com o TOTVS iPaaS. Chame a tool `iniciar_login_ipaas` para abrir o navegador e fazer login antes de continuar.",
    nextStep: "iniciar_login_ipaas",
  });
}

/** Converte uma falha em resposta legivel, sem nunca lancar pelo canal MCP. */
export function errorResponse(message: string, cause?: unknown): ToolTextResult {
  const detail =
    cause instanceof Error ? ` (${cause.name}: ${cause.message})` : cause ? ` (${String(cause)})` : "";
  return text("Erro: " + (message ?? "ocorreu um erro inesperado") + detail);
}
