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

As demais variaveis dependem dos recursos habilitados, por exemplo Redis, S3, RabbitMQ, SQS, NATS, Kafka, Chatwoot, Typebot e webhooks.

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
10. Fazer deploy e procurar nesta ordem:
   - `Loaded Prisma config from prisma.config.ts`;
   - datasource apontando para o banco correto;
   - `No pending migrations to apply` ou migrations aplicadas;
   - `HTTP - ON: 8080`;
   - `Redis ready`, quando Redis estiver habilitado.
11. Ativar a instancia no manager ou fornecer uma chave de licenciamento valida.

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
