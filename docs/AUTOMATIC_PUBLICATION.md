# Publicação automática de postagens com data e hora

## Cenário editorial
A pessoa escreve três postagens hoje no editor Angular, salva as três em rascunho,
publica a primeira com **Publicar** e agenda as outras duas, cada qual com sua
própria data e hora. Não há limite artificial de uma postagem por dia.

## Fluxo no navegador
1. Salve a postagem. Apenas **editor** e **admin** podem publicar ou agendar.
2. Em **Programar publicação**, selecione data e hora futuras em
   `datetime-local`. O navegador converte a hora local para ISO UTC antes
   de enviar. O NestJS valida novamente contra o relógio do servidor.
3. Clique **Agendar publicação**. O estado passa a `scheduled`; o conteúdo
   continua **privado**, com uma revisão nova no histórico. O editor bloqueia
   salvar/publicar enquanto o estado está agendado.
4. **Publicações agendadas** lista os próximos 50 itens (servidor ordena pela
   data de publicação). Selecione um para reagendar ou cancelar. Cancelar
   retorna para `draft` e permite edição normal.
5. Na data programada, o serviço NestJS publica automaticamente. A página
   pública só passa a retornar o artigo após o commit da publicação.

## Endpoints NestJS
- `POST /api/admin/editorial/drafts/:id/schedule`
  `{"expectedRevision":0,"scheduledAt":"2026-11-10T15:30:00.000Z"}`
- `POST /api/admin/editorial/drafts/:id/cancel-schedule`
  `{"expectedRevision":1}`
- `GET /api/admin/editorial/scheduled`: fila futura limitada a 50,
  ordenada pela data e id. Somente editor/admin. `Cache-Control: no-store`.
- `GET /api/admin/editorial/drafts/:id`: retorna `scheduled` também para
  editores/admins, para permitir gerenciar o agendamento após recarregar a tela.

As escritas exigem sessão, autorização de ação, token CSRF, origem permitida
e revisão esperada (CAS); campos extras não são aceitos. Horários no passado,
malformados ou sem offset UTC canônico são rejeitados. O autor não pode
agendar, cancelar nem listar a fila.

## Execução automática e durabilidade
`ScheduledPublisherWorker` é um provider do NestJS. Com `DATABASE_URL`
configurado, ele executa uma verificação ao iniciar e a cada **30 segundos**.
Cada rodada processa até 10 lotes de 25 itens; o próximo ciclo continua
caso a fila seja maior. Os agendamentos são armazenados no **PostgreSQL**
(`cms_posts.scheduled_at`), não em timers por artigo. Se a API estiver
desligada na hora prevista, a publicação será processada após voltar a funcionar.

A lista de vencimentos seleciona `status='scheduled'`, `scheduled_at <= now`,
ordenada por `scheduled_at, id`. Cada item só é publicado com um UPDATE que
exige simultaneamente **id, revisão, status, data original do agendamento
e vencimento**. O UPDATE e a criação de `cms_post_revisions` com origem
`system_key='scheduled-publisher'` usam a **mesma transação**. Se outra
instância publicar, cancelar ou reagendar primeiro, o concorrente não grava
nada. Se a gravação do histórico falhar, o status volta a `scheduled`.
O campo `published_at` representa o instante **real** de publicação e
`scheduled_at` é zerado, conforme os constraints do schema.

Não há execução cron no GitHub Actions nem chamada Cloudflare Pages que
possa garantir o horário: o **backend NestJS deve estar implantado,
rodando continuamente e com acesso ao PostgreSQL**. Pode haver atraso de
até ~30 s em condições normais e maior atraso em falhas ou indisponibilidade.

## Verificações
- Casos reais HTTP NestJS/PostgreSQL: três artigos, um publicado agora, dois
  programados para dias distintos; CSRF, RBAC, past/future, isolamento;
  cancelamento/reagendamento; duas execuções simultâneas; não republicar;
  snapshots de origem system; rollback em falha de histórico.
- Playwright Angular Chromium desktop/mobile: agendar, recarregar, listar,
  reagendar, cancelar, bloquear alterações locais, rejeitar data antiga.
- CI também executa Angular AOT/SAC e a suíte editorial existente.

Nenhum deploy, alteração de schema ou migração em banco povoado faz parte
deste PR. A proposta `database/proposals/002_editorial_storage_draft.sql`
já contempla status e índice de agendamento; o projeto ainda deve passar
por preparação/revisão de banco isolado antes de entrar em produção.
