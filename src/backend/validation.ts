export class InputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InputError('Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new InputError('Request contains an unsupported field.');
}
export function string(value: unknown, name: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new InputError(`${name} must be a nonempty string of at most ${max} characters.`);
  return value.trim();
}
export function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new InputError('Expected a boolean.');
  return value;
}
export function version(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^v\d+$/.test(value)) throw new InputError('Version must have the form v0, v1, etc.');
  return value;
}
export function projectUrl(value: unknown): string {
  const input = string(value, 'url');
  let url: URL; try { url = new URL(input); } catch { throw new InputError('url must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new InputError('url must be HTTP(S) without embedded credentials.');
  url.hash = ''; return url.href;
}
