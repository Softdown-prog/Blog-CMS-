import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorialActor, EditorialPost, EditorialCommand, decideEditorialTransition } from './policy';

const NOW = '2026-11-04T13:00:00.000Z';
const TOMORROW = '2026-11-05T13:00:00.000Z';
const editor: EditorialActor = { id: 'editor-1', role: 'editor' };
const admin: EditorialActor = { id: 'admin-1', role: 'admin' };
const author: EditorialActor = { id: 'author-1', role: 'author' };
const stranger: EditorialActor = { id: 'author-2', role: 'author' };
const draft: EditorialPost = {
  id: 'post-1', authorId: author.id, revision: 3, status: 'draft',
  title: 'Meu artigo', slug: 'meu-artigo', excerpt: 'Apresentação',
  body: { schemaVersion: 1, blocks: [{ type: 'paragraph', text: 'Conteúdo inicial' }] },
  publishedAt: null,
};
const command = (operation: EditorialCommand['operation'], extra: Partial<EditorialCommand> = {}): EditorialCommand =>
  ({ operation, expectedRevision: 3, ...extra });

test('autor pode editar ou arquivar somente seu próprio rascunho', () => {
  assert.equal(decideEditorialTransition(author, draft, command('edit'), NOW).ok, true);
  assert.equal(decideEditorialTransition(author, draft, command('archive'), NOW).ok, true);
  assert.deepEqual(decideEditorialTransition(stranger, draft, command('edit'), NOW), { ok: false, reason: 'forbidden' });
  assert.deepEqual(decideEditorialTransition(author, draft, command('publish'), NOW), { ok: false, reason: 'forbidden' });
});

test('editor agenda no futuro; agendamento passado ou formato inseguro são bloqueados', () => {
  assert.deepEqual(decideEditorialTransition(editor, draft, command('schedule', { scheduledAt: TOMORROW }), NOW),
    { ok: true, nextStatus: 'scheduled', nextPublishedAt: TOMORROW });
  assert.deepEqual(decideEditorialTransition(editor, draft, command('schedule', { scheduledAt: NOW }), NOW),
    { ok: false, reason: 'invalid-schedule' });
  assert.deepEqual(decideEditorialTransition(editor, draft, command('schedule', { scheduledAt: '2030-01-01' }), NOW),
    { ok: false, reason: 'invalid-schedule' });
});

test('publicação exige título, slug e conteúdo válido', () => {
  assert.deepEqual(decideEditorialTransition(editor, draft, command('publish'), NOW),
    { ok: true, nextStatus: 'published', nextPublishedAt: NOW });
  const bad = [
    { ...draft, title: ' ' },
    { ...draft, slug: '../admin' },
    { ...draft, body: { schemaVersion: 1, blocks: [] } },
    { ...draft, body: { schemaVersion: 1, blocks: [{ type: 'raw-html', html: '<script/>' }] } },
  ];
  for (const post of bad) {
    assert.deepEqual(decideEditorialTransition(admin, post, command('publish'), NOW),
      { ok: false, reason: 'not-publishable' });
  }
});

test('revisão desatualizada não autoriza nenhuma transição', () => {
  assert.deepEqual(decideEditorialTransition(editor, draft, command('publish', { expectedRevision: 2 }), NOW),
    { ok: false, reason: 'stale-revision' });
  assert.deepEqual(decideEditorialTransition(editor, draft, command('publish', { expectedRevision: Number.NaN }), NOW),
    { ok: false, reason: 'stale-revision' });
});

test('estado arquivado só pode ser restaurado; editor pode cancelar agendamento', () => {
  const archived: EditorialPost = { ...draft, status: 'archived', publishedAt: TOMORROW };
  assert.deepEqual(decideEditorialTransition(admin, archived, command('restore'), NOW),
    { ok: true, nextStatus: 'draft', nextPublishedAt: null });
  assert.deepEqual(decideEditorialTransition(admin, archived, command('publish'), NOW),
    { ok: false, reason: 'invalid-transition' });
  const scheduled: EditorialPost = { ...draft, status: 'scheduled', publishedAt: TOMORROW };
  assert.deepEqual(decideEditorialTransition(editor, scheduled, command('unschedule'), NOW),
    { ok: true, nextStatus: 'draft', nextPublishedAt: null });
  assert.deepEqual(decideEditorialTransition(author, scheduled, command('edit'), NOW),
    { ok: false, reason: 'forbidden' });
});

test('decisão não muda objeto original nem faz IO', () => {
  const before = JSON.stringify(draft);
  decideEditorialTransition(editor, draft, command('publish'), NOW);
  assert.equal(JSON.stringify(draft), before);
});

