# Integração com Softdown-prog/Data_libray

Origem: https://github.com/Softdown-prog/Data_libray
Commit pinado na CI: `3a36bac3fd3a59520fa6ee49bb1e390174368d03`.

## Integração já especificada
1. Checkout **somente leitura** do Data_libray em `_sac/` no job isolado de CI.
2. Instalar dependências do Angular e dos pacotes SAC com `npm ci`.
3. O script `scripts/sac-build.mjs` seleciona explicitamente fontes, calcula perfil compatível e chama `prepareBuild` (SAC-PRE001).
4. Limpa dist e chama o compilador Angular oficial com argumentos **fixos**.
5. Chama `sealBuild` com chave aleatória efêmera do job; `auditPipeline` valida o comprovante e SAC-P001.
6. Falha no pre/build/post retorna erro; o relatório é salvo como artefato de CI. `deployment_authorized` permanece false.

A ferramenta não é substituto para os testes de navegador. O Guardian/Chromium será ativado com contrato real de UI e isolamento externo em etapa futura; **não declarar browser-pass** nesta fase. O worker VPS existente da biblioteca não é alterado nem executa o CMS remotamente.

## Pontos de controle
- Comprovação de inputs selecionados não abrange dependências transitivas nem secrets.
- Os lockfiles temporários usados no bootstrap CI precisam ser revisados e commitados. Até lá, **não considerar CI reprodutível**.
- Não promover deploy só com um status verde.
- A biblioteca de exemplos continua independente; não copiar regras para dentro do CMS nem criar um compilador paralelo.

