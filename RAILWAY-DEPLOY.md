# Deploy da Evolution API no Railway

Este documento registra o problema de deploy enfrentado nesta instalação da Evolution API v2.4.0-rc2, as causas identificadas, as correcoes aplicadas e os cuidados necessarios para repetir a instalacao em outro ambiente.

## Resultado final

O container passou a executar corretamente o fluxo abaixo:

1. Carrega `prisma.config.ts`.
2. Resolve a URL real do PostgreSQL fornecida pelo Railway.
3. Executa `prisma migrate deploy`.
4. Encontra ou aplica as migrations.
5. Inicia a API com HTTP na porta `8080`.
6. Inicializa o Redis e o `PrismaRepository`.

O log final confirmou:

```text
No pending migrations to apply.
Redis ready
HTTP - ON: 8080
```

O aviso de licenciamento que permanece no log e um problema separado de ativacao da instancia. Ele nao impede o processo Node de iniciar, mas faz as rotas de negocio responderem `503 LICENSE_REQUIRED` ate a ativacao.

## Sintoma inicial

O build Docker terminava com sucesso, mas o container reiniciava continuamente no runtime com:

```text
Error: The datasource.url property is required in your Prisma config file when using prisma migrate deploy.
```

Em alguns deploys, o log tambem mostrava:

```text
> evolution-api@2.4.0 db:deploy
> node runWithProvider.js ...
◇ injected env (0) from .env
```

Isso fazia parecer que o Railway estava ignorando o `CMD` do Dockerfile. Depois foi confirmado que havia mais de um problema sobreposto.

## Arquitetura relevante

A aplicacao usa:

- Node.js, TypeScript e Express;
- Prisma 7;
- PostgreSQL ou MySQL selecionados por `DATABASE_PROVIDER`;
- schemas separados: `postgresql-schema.prisma`, `mysql-schema.prisma` e `psql_bouncer-schema.prisma`;
- migrations separadas por provider;
- `prisma.config.ts` para informar schema, migrations e datasource;
- `runWithProvider.js` para executar comandos dinamicos de banco;
- `dotenv`/dotenvx para ler arquivos `.env`;
- Docker multi-stage com etapas `builder` e `final`.

Essa combinacao torna importante distinguir o ambiente de build do ambiente de runtime. A URL usada para gerar o client no build nao deve ser confundida com a URL real usada para conectar ao banco no Railway.

## Causas encontradas

### 1. Prisma 7 nao aceita mais `url` no schema

No Prisma 7, este formato deixou de ser valido no schema:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

A URL precisa ser definida em `prisma.config.ts`. O schema continua definindo o provider, mas a conexao fica na configuracao Prisma.

### 2. `prisma.config.ts` nao estava na imagem final

O Dockerfile copiava o schema e as migrations para a imagem final, mas nao copiava `prisma.config.ts`.

O build conseguia executar o `prisma generate` na etapa `builder`, mas o container final nao tinha a configuracao necessaria para o Prisma 7. Por isso, no runtime o Prisma encontrava `prisma/schema.prisma` sem `url` e falhava.

A correcao foi copiar o arquivo nas duas etapas e chamar o comando explicitamente:

```dockerfile
COPY ./prisma.config.ts ./
COPY --from=builder /evolution/prisma.config.ts ./prisma.config.ts

CMD ["sh", "-c", "npx prisma migrate deploy --config ./prisma.config.ts && npm run start:prod"]
```

### 3. Nomes diferentes para a URL do banco

O Railway fornece normalmente:

```text
DATABASE_URL
```

A Evolution API historicamente le:

```text
DATABASE_CONNECTION_URI
```

A configuracao final aceita ambos, priorizando a variavel nativa do Railway:

```ts
const databaseUrl = process.env.DATABASE_URL ?? process.env.DATABASE_CONNECTION_URI;
```

No runtime da aplicacao, `DATABASE_URL` tambem e normalizada para `DATABASE_CONNECTION_URI`, porque partes da API ainda consultam o nome antigo.

### 4. Arquivo `.env` fisico interferindo no ambiente

O Dockerfile antigo copiava um arquivo de exemplo para dentro da imagem:

```dockerfile
COPY ./.env.example ./.env
```

Essa estrategia e incorreta em ambientes como Railway. O Railway injeta as variaveis reais no processo em runtime, enquanto o arquivo `.env` contem placeholders, valores locais ou valores vazios.

O `.env` fisico foi removido da imagem final. O ambiente de producao agora depende das variaveis fornecidas pelo Railway.

O log abaixo nao indica falha:

```text
injected env (0) from .env
```

O `0` significa que nenhum valor foi carregado do arquivo. O processo continua usando as variaveis nativas do Railway.

### 5. `SERVER_TYPE` era sobrescrito como `undefined`

Depois que o Prisma foi corrigido, surgiu um segundo crash:

```text
TypeError: Cannot read properties of undefined (reading 'listen')
```

A causa estava em `src/config/env.config.ts`. Quando `DOCKER_ENV=true`, o codigo fazia uma atribuicao direta:

```ts
this.env.SERVER.TYPE = process.env.SERVER_TYPE;
```

Se `SERVER_TYPE` nao existisse no Railway, o valor default `http` era apagado e substituido por `undefined`. Em seguida, `ServerUP[undefined]` tambem resultava em `undefined`.

A correcao foi:

```ts
TYPE: process.env.SERVER_TYPE?.toLowerCase() === 'https' ? 'https' : 'http',
```

E o Dockerfile passou a declarar defaults:

```dockerfile
ENV SERVER_TYPE=http
ENV SERVER_PORT=8080
```

O fallback em `main.ts` tambem passou a tratar qualquer valor falsy:

```ts
if (!server) {
```

## O que nao era a causa

### Aviso de atualizacao do npm

Mensagens como esta sao informativas:

```text
npm notice New major version of npm available
```

Elas nao interrompem o processo.

### Reexecucao das migrations

Durante os crashes do servidor, o Railway reiniciava o container inteiro. Como o `CMD` comeca pela migration, cada reinicio executava novamente:

```text
prisma migrate deploy
```

Depois da primeira aplicacao, o resultado passou a ser:

```text
No pending migrations to apply.
```

Isso nao era um loop de migrations com falha. Era o loop de restart do container causado pelo crash posterior do servidor.

### `runWithProvider.js`

O `package.json` nao possuia `prestart`, `poststart` ou `prestart:prod` chamando `db:deploy`. Quando os logs mostravam `npm run db:deploy`, isso correspondia a um Start Command antigo ou customizado do Railway, ou a um script de instalacao executado externamente.

O runtime final passou a chamar diretamente:

```text
npx prisma migrate deploy --config ./prisma.config.ts
```

## Historico do `.env.example`

O arquivo de exemplo completo foi apagado no commit:

```text
51227523 apagado todo conteudo para que na fase de build do railway consiga passar
```

Esse commit removeu 429 linhas de `.env.example`.

O arquivo foi restaurado a partir do commit pai `51227523^`. O arquivo de exemplo deve continuar no repositorio para documentar as configuracoes, mas nao deve ser copiado para `.env` dentro da imagem Docker.

Existe tambem um arquivo separado chamado `env.example`, com variaveis adicionais do fork. Esses dois arquivos devem ser tratados com cuidado para evitar duas fontes oficiais conflitantes. Antes de uma nova mudanca grande, e recomendavel consolidar a documentacao em um unico arquivo oficial.

## Configuracao recomendada no Railway

O servico da API precisa receber, no minimo:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
DATABASE_PROVIDER=postgresql
SERVER_TYPE=http
SERVER_PORT=8080
AUTHENTICATION_API_KEY=<chave de licenciamento valida>
```

Para uma instancia que efetivamente conecta no WhatsApp (QR code) e persiste dados para integracoes externas (ex.: help.ia lendo a tabela `Message` direto no Postgres), tambem sao obrigatorias:

```text
# Sem isso o createClient() quebra com "Cannot read properties of undefined (reading 'state')"
# ao gerar o QR code (defineAuthState() nao retorna nada sem pelo menos uma dessas duas):
DATABASE_SAVE_DATA_INSTANCE=true
# e/ou
CACHE_REDIS_ENABLED=true
CACHE_REDIS_SAVE_INSTANCES=true

# Sem isso a Evolution nao grava a mensagem recebida na tabela "Message",
# quebrando qualquer integracao externa que dependa de consultar essa tabela
# (ex.: recuperar o messageSecret para decriptar uma edicao de mensagem):
DATABASE_SAVE_DATA_NEW_MESSAGE=true
DATABASE_SAVE_MESSAGE_UPDATE=true
DATABASE_SAVE_DATA_CONTACTS=true
DATABASE_SAVE_DATA_CHATS=true
DATABASE_SAVE_DATA_HISTORIC=true
DATABASE_SAVE_DATA_LABELS=true
```

> **Atencao a nomes de variavel legados**: instalacoes antigas desta API (RC anteriores) usavam `DATABASE_SAVE_MESSAGES` e `STORE_MESSAGES` para controlar o salvamento de mensagens novas. Esta versao **nao reconhece mais esses nomes** — o parametro correto e `DATABASE_SAVE_DATA_NEW_MESSAGE`. Copiar variaveis de um ambiente antigo direto para um novo sem revisar os nomes reproduz silenciosamente esse tipo de regressao (o valor antigo e apenas ignorado, sem erro).

As demais variaveis dependem dos recursos habilitados, por exemplo S3, RabbitMQ, SQS, NATS, Kafka, Chatwoot, Typebot e webhooks.

Nao e necessario cadastrar todas as variaveis do arquivo de exemplo. Variaveis opcionais podem permanecer ausentes quando o recurso correspondente esta desabilitado ou possui default seguro.

O Start Command customizado do Railway deve ficar vazio para que o Railway use o `CMD` do Dockerfile. Se um Start Command for necessario, ele deve preservar o fluxo equivalente:

```sh
npx prisma migrate deploy --config ./prisma.config.ts && npm run start:prod
```

Nao usar como comando de producao sem necessidade:

```sh
npm run db:deploy
bash Docker/scripts/deploy_database.sh
```

Esses comandos pertencem ao fluxo multi-provider tradicional e usam `runWithProvider.js`. Eles sao uteis para desenvolvimento e instalacoes locais, mas aumentam a superficie de conflito quando o provider e a URL ja foram definidos diretamente no container.

## Checklist para outra instalacao

1. Escolher PostgreSQL ou MySQL e definir `DATABASE_PROVIDER`.
2. Criar o servico de banco e confirmar que a API recebe `DATABASE_URL`.
3. Nao criar um `.env` com placeholders dentro da imagem Docker.
4. Garantir que `prisma.config.ts` seja copiado para a imagem final.
5. Garantir que o schema do provider e suas migrations estejam em `prisma/`.
6. Executar `prisma generate` no build com uma URL sinteticamente valida, sem depender do banco real.
7. Executar `prisma migrate deploy --config ./prisma.config.ts` somente no runtime.
8. Confirmar `SERVER_TYPE=http` e `SERVER_PORT=8080` para um servico HTTP comum.
9. Deixar o Start Command do Railway vazio ou equivalente ao `CMD` da imagem.
10. Copiar (nao presumir) as variaveis `DATABASE_SAVE_DATA_*` / `CACHE_REDIS_*` de um ambiente de referencia, conferindo se os **nomes** ainda sao validos nesta versao (ver secao "Configuracao recomendada no Railway").
11. Fazer deploy e procurar nesta ordem:
   - `Loaded Prisma config from prisma.config.ts`;
   - datasource apontando para o banco correto;
   - `No pending migrations to apply` ou migrations aplicadas;
   - `HTTP - ON: 8080`;
   - `Redis ready`, quando Redis estiver habilitado.
12. Ativar a instancia no manager ou fornecer uma chave de licenciamento valida.
13. Criar uma instancia pelo Manager, conectar via QR code e testar envio/recebimento de texto, midia (imagem/audio/video) e edicao de mensagem antes de considerar o ambiente validado.

## Regras de prevencao

- Nunca usar `.env.example` como `.env` de producao.
- Nunca apagar o arquivo de exemplo para resolver problema de build; o build deve ser corrigido no Dockerfile.
- Ao atualizar Prisma, conferir simultaneamente schema, `prisma.config.ts`, generator, client gerado, adapters e Dockerfile.
- Ao alterar nomes de variaveis de ambiente, atualizar Prisma, runtime da API, scripts de banco e documentacao juntos.
- Ao introduzir defaults para Docker, manter os mesmos defaults na configuracao TypeScript.
- Distinguir falha de build, falha de migration, falha de boot HTTP e falha de licenciamento.
- Validar uma imagem nova sem cache quando um arquivo de configuracao foi adicionado ou removido.
- Nao considerar um container saudavel apenas porque migrations passaram; o criterio inclui o servidor escutando na porta esperada.

## Estado validado nesta instalacao

A instalacao foi validada pelos logs do Railway com:

```text
Prisma config carregado
PostgreSQL conectado
59 migrations encontradas
No pending migrations to apply
Redis ready
PrismaRepository - ON
HTTP - ON: 8080
```

O unico aviso pendente no momento e a ativacao da licenca da Evolution API:

```text
Global API key not accepted by licensing server: invalid signature (HTTP 401)
```

Esse aviso deve ser resolvido no fluxo de licenciamento, nao no Dockerfile, no Prisma ou nas migrations.

## Sessao de validacao do fix PR #2708 (branch `feat/quoted-context-canary`)

Contexto: um ambiente "canary" foi criado no Railway (banco Postgres e Redis proprios, apontados por um backend externo — help.ia) especificamente para validar se o [PR #2708](https://github.com/evolution-foundation/evolution-api/pull/2708) (preservacao do `contextInfo` de reply/quote em mensagens de texto) resolve um bug ja conhecido em producao, antes de promover o fix para a versao oficial. Durante essa validacao, quatro problemas foram encontrados e corrigidos.

### 1. Manager UI enviava `name`, API esperava `instanceName`

**Sintoma**: criar instancia pelo Manager retornava 500 do Prisma (`Argument \`name\` is missing`) e, apos um primeiro ajuste, 400 (`The "instanceName" cannot be empty`).

**Causa raiz**: em `src/api/abstract/abstract.router.ts`, a funcao `sanitizeUntrustedInput` remove os campos `instanceName`/`instanceId` de qualquer body recebido, como protecao contra spoofing em rotas onde esse valor deveria vir da URL (`:instanceName`). Só que a rota `POST /instance/create` **nao tem** `:instanceName` na URL — o nome so pode vir do body — entao esse filtro de seguranca removia o proprio dado necessario antes de chegar no controller.

**Correcao**: `sanitizeUntrustedInput` passou a aceitar uma lista de campos protegidos por chamada; para `/instance/create` apenas `instanceId` continua protegido (gerado pelo servidor), liberando `instanceName` do body. Tambem foi adicionado um fallback no controller (`instanceData.name` como alias) para tolerar builds do Manager que usem o nome de campo antigo.

### 2. QR code nao carregava — `defineAuthState()` retornando `undefined`

**Sintoma**: `TypeError: Cannot read properties of undefined (reading 'state')` em `createClient()`, logo apos clicar para conectar a instancia.

**Causa raiz**: faltavam as variaveis `DATABASE_SAVE_DATA_INSTANCE` e/ou `CACHE_REDIS_SAVE_INSTANCES` no servico Railway da Evolution canary. Sem nenhuma das duas, `defineAuthState()` nao retorna nada, e `this.instance.authState.state.creds` quebra.

**Correcao**: adicionar `DATABASE_SAVE_DATA_INSTANCE=true` (e conferir `CACHE_REDIS_ENABLED`/`CACHE_REDIS_SAVE_INSTANCES` se for usar Redis para sessoes) nas variaveis do servico.

### 3. Edicao de mensagem (MESSAGE_UPDATE) parou de funcionar no help.ia

**Sintoma**: o help.ia nao conseguia mais recuperar o `messageSecret` da mensagem original (consulta direta na tabela `Message` do Postgres da Evolution) para decriptar edicoes vindas do WhatsApp Web/mobile. Log: `Mensagem original ... nao encontrada na tabela "Message"`.

**Causa raiz**: **nao foi uma regressao de codigo**. O ambiente de producao antigo (RC) usava as variaveis `DATABASE_SAVE_MESSAGES=true` e `STORE_MESSAGES=true` para habilitar o salvamento de mensagens recebidas. Essas variaveis **nao existem mais** nesta versao — foram renomeadas para `DATABASE_SAVE_DATA_NEW_MESSAGE`. Como o ambiente canary replicou as variaveis do ambiente antigo sem revisar os nomes, o parametro novo ficou com o valor padrao (`false`) e a Evolution parou de persistir mensagens na tabela `Message`.

**Correcao**: adicionar `DATABASE_SAVE_DATA_NEW_MESSAGE=true` (o `DATABASE_SAVE_MESSAGE_UPDATE=true` ja estava correto, pois esse nome nao mudou). As variaveis antigas (`DATABASE_SAVE_MESSAGES`, `STORE_MESSAGES`) podem permanecer sem causar dano — sao apenas ignoradas — mas devem ser removidas na limpeza final para evitar confusao.

### 4. Envio de audio/video falhando com proxy habilitado ("Media upload failed on all hosts")

**Sintoma**: envio de audio PTT retornava 400 com `Error: Media upload failed on all hosts`; envio de video excedia o timeout do cliente (35s) sem completar em tempo habil.

**Causa raiz**: o Baileys `7.0.0-rc13` mudou a implementacao interna de upload de midia. Em runtime Node.js (o nosso caso — nao Bun/Deno), o upload usa os modulos nativos `https`/`http` com um **Agent tradicional do Node** (opcao `fetchAgent` do `SocketConfig`, repassada como `agent` para `http.request`). So em runtimes Bun/Deno/browser e que o Baileys usa `fetch` com um dispatcher Undici. O codigo em `createClient()` (whatsapp.baileys.service.ts) passava `fetchAgent: makeProxyAgentUndici(...)` — um `ProxyAgent` do Undici, incompativel com a API de Agent do Node — entao todo upload de midia com proxy habilitado falhava silenciosamente em todos os hosts.

**Correcao**: `fetchAgent` passou a usar `makeProxyAgent(...)` (o mesmo Agent tradicional ja usado em `agent`), compativel com o caminho de upload via `https`/`http` nativo usado pelo Baileys em Node.js. Esse bug so se manifesta quando a instancia tem um proxy configurado (`this.localProxy?.enabled`).

### Licao geral desta sessao

A maior parte dos problemas encontrados ao subir esta versao mais nova nao foram bugs de codigo, e sim **variaveis de ambiente renomeadas ou omitidas** ao migrar de um ambiente antigo (RC) para este mais novo. Ao clonar configuracao de um ambiente Railway existente para um novo servico/versao, sempre conferir se os **nomes** das variaveis ainda sao os esperados pela versao atual do codigo (`grep` por `process.env` em `src/config/env.config.ts` e nos servicos relevantes), em vez de assumir que copiar os valores basta.
