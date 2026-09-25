export class LabError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LabError';
    this.code = code;
  }
}
