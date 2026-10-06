/** Sinaliza que o login manual nao foi concluido (timeout, abandono ou token ausente). */
export class LoginFailedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LoginFailedError";
  }
}
