# Credenciais e recuperação de senha — fase de arquitetura (sem integrações)

## O que foi implementado
- `apps/api/src/security/password-login.ts`: caso de uso `VerifyPasswordLogin`.
- `apps/api/src/security/password-recovery.ts`: caso de uso `PasswordRecovery`.
- Verificação de credenciais, reservas de limites, desafios descartáveis e CAS são definidos por ports isolados.
- Nada foi conectado a NestJS, Angular, PostgreSQL, envio de e-mail, servidor, controller ou cookie.
- NÃO há um login público funcional, nem tela de recuperação ou verificação real de senha habilitada.

## Login
- E-mail é normalizado em minúsculas, com limite de 254 caracteres; a senha permanece inalterada.
- O futuro adaptador extrairá um networkKey HMAC autenticado do endereço de rede e origem confiável. Nunca aceitar networkKey fornecido pelo cliente.
- `LoginAttemptLimiter.reserve` DEVE reservar atomicamente limites independentes por conta e rede (múltiplos processos).
- `PasswordVerifier` deverá usar biblioteca de verificação Argon2id confiável, com parâmetros moderados de memória e tempo calibrados.
- Usuário inexistente/desativado é submetido à verificação de um hash Argon2id dummy REAL para reduzir diferenças de timing.
- Senha inválida, conta ausente e conta desabilitada retornam `invalid-credentials`, sem revelar presença de e-mail.
- Apenas usuário ativo com hash correto produz `VerifiedLogin` para o serviço interno `SessionLifecycle.issue`.
- `VerifiedLogin` é prova interna confiável, não DTO que um endpoint possa aceitar.
- Rate limit: política de janela, quota, lockout, concorrência e retenção deverão ser definidos e auditados no adapter real.

## Recuperação de acesso
- `PasswordRecovery.request()` responde sempre `if-account-exists`, inclusive para e-mails ausentes ou bloqueados por limite.
- Uma porta cria desafio com token de 256 bits CSPRNG, guarda somente hash SHA-256 e prazo de 15 minutos.
- A porta de armazenamento só emite desafio para conta habilitada; deve substituir desafios anteriores da mesma conta atomicamente.
- O token original é enviado exclusivamente a `RecoveryDelivery`, dependência privada futura. Nunca pode aparecer na resposta HTTP, logs ou URL de analytics.
- Se o envio falhar, a porta tenta invalidar o desafio criado, sem revelar existência da conta.
- `complete()` exige token canônico, política de senha nova com **mínimo de 15 caracteres Unicode e máximo de 1024 bytes**, bloqueio por corpus de senhas comprometidas, proteção de tentativas e hash Argon2id.
- A porta `consumeAndReset` DEVE, em uma só transação, verificar token ainda válido, consumi-lo UMA vez, atualizar senha e incrementar `authVersion`.
- Incrementar `authVersion` invalida todas as sessões antigas. Token expirado/usado não pode alterar senha.
- A rejeição de senhas comprometidas já é obrigatória por porta `PasswordBlocklist`, mas o **corpus real e testes de reutilização de senha antiga ainda precisam ser implementados**. Não transmitir senha em texto claro para serviços externos.

## Regras de integração final
- Conectar o limiter com estado compartilhado entre instâncias (limites por IP e por conta, sem armazenar IP/e-mail desnecessariamente).
- Endereços de rede deverão ser derivados de configuração correta de reverse proxy; não confiar em X-Forwarded-For arbitrário.
- Implementar PasswordVerifier e PasswordHasher com biblioteca auditada, parametrização versionada e mitigação de DoS.
- Garantir respostas uniformes sem diferenças observáveis de status/erro que permitam enumeração; medir timing sob carga.
- Envio de recuperação por provedor verificado com URL allowlist, domínio canônico, não incluir senha no link e política de redirecionamento estrita.
- Proteger o token enviado por e-mail de vazamento em referer, cache, logs e monitoramento; preferir fluxo com token consumido no backend.
- MFA, integração transacional da auditoria, notificações de troca de senha, implementação persistente dos limites e prevenção de abuso ainda pendentes. Novos contratos puros de política e auditoria: [PASSWORD_POLICY_AUDIT.md](PASSWORD_POLICY_AUDIT.md).
- O fluxo de e-mail deve ser resiliente a falhas de entrega; registrar incidentes por canal interno sem expor o identificador na API.
- Provar CAS em PostgreSQL real descartável e teste de corrida entre duas conexões antes de qualquer deploy.

## Testes e limites
- Testes usam somente verificadores, armazenamentos, mensageiros e limitadores SIMULADOS.
- Não há teste de resistência criptográfica do Argon2id (a biblioteca real ainda não está instalada).
- Não há teste real de rede, servidor de e-mail, banco, browser ou autenticação HTTP.
- SAC/Angular AOT/TypeScript são verificações de compilação e integração estática, não autorização de produção.

## Política de desenvolvimento
Arquitetura e testes isolados -> módulos internos e interface -> validações em navegador ->
integrações por último -> homologação e autorização explícita para merge e deploy.
