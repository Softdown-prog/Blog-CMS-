/** Proveniência editorial persistida, nunca retirada do JSON do cliente. */
export type UserRevisionOrigin = Readonly<{ kind: 'user'; userId: string }>;
export type SystemRevisionOrigin = Readonly<{ kind: 'system'; service: 'scheduled-publisher' }>;
export type RevisionOrigin = UserRevisionOrigin | SystemRevisionOrigin;

export const SCHEDULED_PUBLISHER_ORIGIN: SystemRevisionOrigin = Object.freeze({
  kind: 'system', service: 'scheduled-publisher',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rejeita propriedades extras para não transportar IDs, tokens ou claims falsos. */
export function isRevisionOrigin(value: unknown): value is RevisionOrigin {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (data['kind'] === 'user') {
    return Object.keys(data).length === 2
      && Object.hasOwn(data, 'userId')
      && typeof data['userId'] === 'string' && UUID.test(data['userId']);
  }
  if (data['kind'] === 'system') {
    return Object.keys(data).length === 2
      && Object.hasOwn(data, 'service')
      && data['service'] === 'scheduled-publisher';
  }
  return false;
}

