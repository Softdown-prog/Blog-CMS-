# Pré-upload de mídia — contrato de segurança v1 (offline)

## Fronteira

`media-upload-preflight.ts` valida apenas **a solicitação de reservar**.
Não recebe bytes, não aceita arquivo, não libera URL, não valida magic bytes,
não gera thumbnails, não armazena conteúdo e não acessa PostgreSQL.
É uma preparação para uma futura API autenticada com limite de streaming.

## Atores, cotas e idempotência

- Usar ator autenticado no servidor; ignorar ID/role declarados por cliente.
- Autor, editor e admin só podem iniciar uma reserva para o próprio usuário;
  acessos delegados/entre equipes precisam de fluxo próprio no futuro.
- Limites propostos: 20 MiB/arquivo, 100 MiB/usuário e 200 arquivos/usuário.
  Quota deve contar bytes armazenados MAIS reservas ainda válidas.
- `operationId` é UUID escopado ao usuário e argumentos canônicos, para
  repetir solicitações em caso de resposta perdida sem cobrar duas vezes.
  Não é segredo nem prova de autorização; validação CSRF/Origin é separada.
- `MediaUploadReservationPort.reserveAtomically` deve verificar quota,
  idempotência e escopo de usuário sob isolamento transacional e persistir
  reservas e consumo no MESMO COMMIT. Retornos válidos:
  reserved, replayed, quota-exceeded e conflict; demais falham fechado.

## Pipeline real — NÃO implementado

1. Confirmar sessão HttpOnly, CSRF e Origin com política de ações apropriada.
2. Reservar cota atomicamente e estabelecer TTL de reserva.
3. Receber stream limitado de arquivo em quarentena isolada, contando bytes.
4. Detectar formato e tamanho real por conteúdo, não confiar no nome/MIME.
5. Decodificar em processo restrito, impor limites de pixels e tempo de CPU.
6. Reencodar formatos permitidos, remover EXIF/metadados, produzir derivados.
7. Verificar posse/autorizações e registrar ativo/consumo de quota
   transacionalmente; só então emitir URLs controladas e vincular ao post.
8. Expirar reservas não concluídas, estornar quota e remover bytes órfãos,
   guardando tombstone de operação para não duplicar COMMIT após timeout.

Cuidado com respostas perdidas, múltiplos workers, corridas e falhas durante
transferência. Não prometer exactly-once para armazenamento de objetos.

## Especificação de miniaturas

Dois perfis sem processamento: WebP small (máximo 320 px) e large (máximo
960 px), fit inside, sem upscaling e com remoção de metadados. Gerar apenas
a partir de conteúdo previamente validado. Como nenhum decoder está ligado,
estes perfis não produzem imagens nem evidenciam segurança de arquivos.

## Testes

Testes determinísticos do contrato e de porta falsa atômica cobrem rejeição
de dono diferente, MIME/extensão, tamanho, campos inesperados, quotas,
concorrência, falha antes/depois de COMMIT e replay idempotente. Não medem
streaming, segurança de decodificador, isolamento SQL nem quotas em produção.

## Cancelamento, expiração e recuperação (contratos offline)

O contrato `media-upload-lifecycle.ts` acrescenta:
- Prazo **15 minutos** calculado no primeiro COMMIT da reserva pelo relógio confiável
  passado ao adaptador. Um replay nunca renova esse prazo.
- `CancelMediaUpload.execute` exige a identidade já autenticada do mesmo
  proprietário e o `operationId`, sem aceitar campos extras ou ações
  sobre reservas de outros usuários.
- `ExpireMediaUploads.runOnce` executa apenas UMA varredura limitada (máximo
  100 reservas por execução), usando o relógio do servidor. Não há cron,
  worker, agendamento nem acesso a banco implementados.
- `MediaUploadLifecyclePort` combina a mesma porta de reserva com
  cancelamento e expiração atômicos: ambos mudam estado e devolvem quota
  de bytes e contagem de arquivos em UM COMMIT.
- Estados terminais `cancelled` e `expired` permanecem como
  *tombstones*: `BeginMediaUpload` responde erro nessas duas condições,
  não cria nova reserva com o mesmo ID; uma nova tentativa legítima deve
  usar novo `operationId`.
- Repetição de cancelamento confirmado retorna `replayed`; cancelamento
  após prazo devolve `expired`; falha antes do COMMIT mantém a reserva.
  Uma resposta perdida após COMMIT pode ser reconciliada por nova chamada,
  sem segunda liberação.

**Garantias ainda não demonstradas em produção:** isolamento SQL real,
identidade/CSRF HTTP, retenção persistente dos tombstones, sincronização de
relógio entre workers, limpeza de objetos em armazenamento, transição de
reserva para mídia *realmente validada*, geração de miniaturas e relatórios
de auditoria. Os testes executam um único fake serializável, inclusive nas
simulações de concorrência. Nunca considerar contagem do fake como quota
real do usuário. Antes da integração, dimensionar retenção de idempotência
para que IDs antigos não possam ser reutilizados durante o período de
retransmissões suportado.
