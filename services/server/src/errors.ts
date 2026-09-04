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

export function invalidInput(message: string): MissionGoError {
  return new MissionGoError("validation_failed", message, 400);
}

export function notFound(resource: string): MissionGoError {
  return new MissionGoError("not_found", `${resource} was not found.`, 404);
}

export function conflict(code: string, message: string): MissionGoError {
  return new MissionGoError(code, message, 409);
}
