export class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
  }
}

export const badRequest = (message) => new DomainError("bad_request", message, 400);
export const notFound = (message) => new DomainError("not_found", message, 404);
export const forbidden = (message) => new DomainError("forbidden", message, 403);
export const conflict = (message) => new DomainError("conflict", message, 409);
