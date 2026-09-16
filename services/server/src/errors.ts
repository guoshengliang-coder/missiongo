export class MissionGoError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "MissionGoError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// The code is overridable because a few 400s are worth telling apart in the
// console -- a missing transition note has its own wording, and the page can
// only find it by code. Everything else keeps the generic one.
export function invalidInput(message: string, code = "validation_failed"): MissionGoError {
  return new MissionGoError(code, message, 400);
}

export function notFound(resource: string): MissionGoError {
  return new MissionGoError("not_found", `${resource} was not found.`, 404);
}

export function conflict(code: string, message: string): MissionGoError {
  return new MissionGoError(code, message, 409);
}
