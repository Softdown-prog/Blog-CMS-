import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSecurityAuditEvent, RecordSecurityAudit,
  SecurityAuditEvent, SecurityAuditWriter,
} from './security-audit';

const USER_ID = '839e6d28-2466-46df-b8e7-425d05a2178b';
const EVENT_ID = '7ecda2c8-969f-4d5c-8fbc-463dbaf3b145';
const CORRELATION_ID = '1972c899-7ee8-4f80-a260-dad43c9fc0ab';
const SUBJECT_KEY = 'a'.repeat(64);
const AT = '2026-11-04T21:00:00.000Z';
const anon = {
  type: 'login-rejected',
  subject: { kind: 'anonymous', subjectKey: SUBJECT_KEY },
  correlationId: CORRELATION_ID,
};
const user = {
  type: 'session-revoked',
  subject: { kind: 'user', userId: USER_ID },
  correlationId: CORRELATION_ID,
};

test('evento anônimo não contém email, IP nem segredos na saída', () => {
  const event = buildSecurityAuditEvent(anon, EVENT_ID, AT);
  assert.deepEqual(event, {
    schemaVersion: 1, eventId: EVENT_ID, correlationId: CORRELATION_ID,
    type: 'login-rejected',
    subject: { kind: 'anonymous', subjectKey: SUBJECT_KEY },
    recordedAt: AT,
  });
  const encoded = JSON.stringify(event);
  for (const fragment of ['@', 'password', 'token', 'ipAddress', 'userAgent']) {
    assert.equal(encoded.includes(fragment), false);
  }
});

test('evento do usuário validado guarda apenas ID e tipo fixo', () => {
  const event = buildSecurityAuditEvent(user, EVENT_ID, AT);
  assert.equal(event?.subject.kind, 'user');
  assert.equal(event?.type, 'session-revoked');
  assert.deepEqual(Object.keys(event ?? {}).sort(), [
    'correlationId', 'eventId', 'recordedAt', 'schemaVersion', 'subject', 'type',
  ]);
});

test('eventos anônimos e de usuário têm taxonomia estrita', () => {
  for (const kind of [
    'login-rejected', 'login-throttled', 'password-reset-requested', 'password-reset-rejected',
  ]) {
    assert.notEqual(buildSecurityAuditEvent({ ...anon, type: kind }, EVENT_ID, AT), null);
    assert.equal(buildSecurityAuditEvent({ ...user, type: kind }, EVENT_ID, AT), null);
  }
  for (const kind of [
    'login-approved', 'password-reset-completed', 'session-revoked', 'sessions-revoked-all',
  ]) {
    assert.notEqual(buildSecurityAuditEvent({ ...user, type: kind }, EVENT_ID, AT), null);
    assert.equal(buildSecurityAuditEvent({ ...anon, type: kind }, EVENT_ID, AT), null);
  }
});

test('campos extras no envelope nunca são persistidos', () => {
  for (const field of ['password', 'sessionToken', 'email', 'ipAddress', 'userAgent', 'url']) {
    const request = { ...anon, [field]: 'DADO_SENSIVEL' };
    assert.equal(buildSecurityAuditEvent(request, EVENT_ID, AT), null);
  }
});

test('campos extras no sujeito são rejeitados antes de gravar', () => {
  const malformed = [
    { ...anon, subject: { ...anon.subject, password: 'segredo' } },
    { ...user, subject: { ...user.subject, sessionToken: 'segredo' } },
    { ...user, subject: { kind: 'user', userId: 'admin' } },
    { ...anon, subject: { kind: 'anonymous', subjectKey: '127.0.0.1' } },
    { ...anon, subject: { kind: 'admin', subjectKey: SUBJECT_KEY } },
  ];
  for (const data of malformed) assert.equal(buildSecurityAuditEvent(data, EVENT_ID, AT), null);
});

test('nomes livres de eventos, nulos e arrays falham fechados', () => {
  for (const request of [
    { ...anon, type: 'custom-error: password=123' },
    { ...anon, type: 'login-failed', message: 'secret' },
    {}, [], null, 'login-rejected', 42,
  ]) assert.equal(buildSecurityAuditEvent(request, EVENT_ID, AT), null);
});

test('timestamp UTC precisa ser canônico e IDs precisam ser UUID', () => {
  for (const at of ['2026-11-04T21:00:00Z', '2026-11-04', 'ontem', '', null]) {
    assert.equal(buildSecurityAuditEvent(anon, EVENT_ID, at), null);
  }
  assert.equal(buildSecurityAuditEvent(anon, 'not-id', AT), null);
  assert.equal(buildSecurityAuditEvent({ ...anon, correlationId: 'not-id' }, EVENT_ID, AT), null);
});

test('mudança posterior no objeto de origem não altera o registro criado', () => {
  const mutable = {
    type: 'login-rejected',
    subject: { kind: 'anonymous', subjectKey: SUBJECT_KEY },
    correlationId: CORRELATION_ID,
  };
  const result = buildSecurityAuditEvent(mutable, EVENT_ID, AT);
  mutable.subject.subjectKey = 'b'.repeat(64);
  mutable.type = 'suspicious activity';
  assert.equal(result?.subject.kind, 'anonymous');
  if (result?.subject.kind !== 'anonymous') return;
  assert.equal(result.subject.subjectKey, SUBJECT_KEY);
  assert.equal(result.type, 'login-rejected');
});

class FakeWriter implements SecurityAuditWriter {
  readonly events: SecurityAuditEvent[] = [];
  fail = false;
  async append(event: SecurityAuditEvent): Promise<void> {
    if (this.fail) throw new Error('audit store failed');
    this.events.push(event);
  }
}

test('serviço de auditoria grava somente eventos validados', async () => {
  const writer = new FakeWriter();
  const service = new RecordSecurityAudit(writer, () => AT, () => EVENT_ID);
  assert.equal(await service.execute(anon), true);
  assert.equal(await service.execute({ ...anon, password: 'não registrar' }), false);
  assert.equal(writer.events.length, 1);
  assert.equal(writer.events[0]?.eventId, EVENT_ID);
});

test('erro de auditoria é propagado em vez de reportar gravação concluída', async () => {
  const writer = new FakeWriter();
  writer.fail = true;
  const service = new RecordSecurityAudit(writer, () => AT, () => EVENT_ID);
  await assert.rejects(service.execute(user), /audit store failed/);
  assert.equal(writer.events.length, 0);
});

test('relógio malformado não dispara gravação', async () => {
  const writer = new FakeWriter();
  const service = new RecordSecurityAudit(writer, () => '2026-11-04', () => EVENT_ID);
  assert.equal(await service.execute(anon), false);
  assert.equal(writer.events.length, 0);
});

