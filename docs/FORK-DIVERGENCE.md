# Divergência do fork — o que perdemos ao voltar para a imagem oficial

**Repositório:** `Mao-na-Massa-Aceleradora-Digital/evolution-api`
**Branch de referência:** `feat/quoted-context-canary` (é a `main` de fato deste fork)
**Levantado em:** 21/09/2026
**Refs do upstream na data:** `upstream/main` = `fa09d378` (06/05/2026, v2.3.7) · `upstream/develop` = `e273b904` (14/07/2026, v2.4.0)

Este documento existe para responder uma pergunta específica: **se um dia apontarmos o backend do
Help.ia para a imagem oficial da Evolution API, o que deixa de funcionar?**

Refazer o levantamento: `git fetch upstream && git log --oneline upstream/develop..HEAD`.

---

## 0. Dois cenários muito diferentes

"Voltar para o oficial" é ambíguo e a diferença é enorme.

| | Base | Commits do fork à frente | O que se perde |
|---|---|---|---|
| **Cenário A** | `upstream/main` — linha 2.3.x | 170 | O fork **mais** todo o `develop`: Baileys rc13→rc.9, Prisma 7→6, Express 5→4, canal EvoHub, `fetchLid`, carrossel/interativos, correção de auth bypass cross-instance (`7a55a2bf`) |
| **Cenário B** | `upstream/develop` — 2.4.0, quando virar release | **27** | Só os itens deste documento |

O "169 commits à frente" que circulou antes era contado contra `upstream/main` e é **enganoso**: 143
daqueles commits são do próprio upstream (`develop`), não nossos. **A customização real são 27
commits**, tocando 10 arquivos.

**Cenário A não é viável** como "voltar ao oficial": exige downgrade de Prisma 7→6 e Baileys
rc13→rc.9, com impacto de schema no banco de produção, além de perder features do upstream. Se a
conversa for sobre voltar ao oficial, é o **Cenário B** que faz sentido.

---

## 1. Bloqueantes — o Help.ia quebra sem isto

### 1.1 Reconexão no 408 com backoff limitado
`68c00647` · `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`

No Baileys, `408` é `connectionLost`/`timedOut` — como o keep-alive de 30s reporta um socket que
parou de responder. No upstream ele está em `codesToNotReconnect`, o que faz **toda queda transiente**
tomar o caminho terminal: `logout.instance` → `cleaningUp()` → **apagar as linhas de sessão e o
diretório da instância**. A credencial é destruída e o número só volta com **QR novo**.

Nosso fix: 408 sai da lista; quedas transientes reconectam com backoff `[3s, 6s, 12s, 30s, 60s, 120s,
300s]` e teto de 20 tentativas; esgotada a escada, a instância fica `closed` **sem** emitir
`logout.instance`, então a credencial sobrevive e `/instance/connect` basta.

**Evidência de produção:** instância `ASSISTENTE-FINANCY`, 18/09/2026 — close `428` às 06:08:21
reconectou sozinha (aberta às 06:08:28); `408` às 06:28:26 foi direto para LOGOUT. A instância
`NATHALIA-PESSOAL-CANARY` perdeu a sessão exatamente assim e precisou de QR presencial.

**Perder isso significa:** qualquer instabilidade de rede desloga a instância permanentemente e
exige intervenção humana com celular em mãos.

**Atenção ao detalhe:** `upstream/main` (2.3.x) **não** tem o 408 na lista, mas também não tem o
backoff limitado nem a preservação de credencial. Voltar para 2.3.x troca este bug por risco de loop
de reconexão sem teto.

### 1.2 `fetchAgent` / proxy agent no Baileys rc13
`c270b721` · mesmo arquivo, em `createClient()`

O Baileys rc13 mudou o upload de mídia: em runtime Node ele usa `https`/`http` nativos e repassa
`fetchAgent` como `agent` para `http.request`. O upstream passa um `ProxyAgent` do **Undici**,
incompatível com a API de Agent do Node. Nosso fix troca por `makeProxyAgent`.

**Perder isso significa:** **todo upload de mídia falha em instância com proxy.** Sintoma: áudio PTT
retorna `400 Media upload failed on all hosts`; vídeo estoura timeout. Envio de texto continua
funcionando, o que torna a falha confusa de diagnosticar.

**Isto é bloqueante para nós, sem condicional:** desde 18/09/2026 o proxy é **global por variável de
ambiente** (`PROXY_HOST`/`PROXY_PROTOCOL=socks5`), então **todas** as instâncias passam por proxy.

### 1.3 Preservação de `stanzaId`/`contextInfo` em mensagens citadas
`5049b158` + `3a6a64c9` · mesmo arquivo (~5184 e ~5700) · relacionado ao PR upstream #2708

`prepareMessage()` achatava `extendedTextMessage` em `conversation` copiando só o `.text`, o que
descartava `contextInfo.stanzaId`, `participant` e `quotedMessage` **antes** de a mensagem chegar aos
webhooks, ao banco e às integrações. O `contextInfo` que sobra vem de `messageContextInfo`, que
carrega `threadId`/`messageSecret` mas **nunca** `stanzaId` — então nada downstream conseguia
recuperar a citação.

O segundo commit é consequência necessária do primeiro: em `fetchMessages()` o fallback de `pushName`
consultava `contextInfo.participant` antes de `messageKey.participant`. Inofensivo enquanto o
`contextInfo` nunca tinha participant; com a citação preservada, passaria a rotular toda resposta com
o autor da mensagem **citada**.

**Perder isso significa:** toda **resposta de texto** chega ao Help.ia órfã, sem saber a que mensagem
responde. Respostas de mídia não são afetadas. É a falha que deu origem a este fork e à branch canary.

**Status upstream:** não mergeado. Existe a branch local `pr-2708` com a submissão.

### 1.4 Guards contra `undefined` em rotas de grupo
`224d1aa3` (rota) + `bf0dc07a` (serviço)

- **Rota** (`src/api/abstract/abstract.router.ts`, em `groupValidate`, `inviteCodeValidate`,
  `getParticipantsValidate`): `request.body` → `request.body ?? {}`. Com **Express 5**, um GET sem
  `Content-Type: application/json` chega com body `undefined`, porque `express.json()` só popula em
  requests JSON.
- **Serviço** (`findGroup`, `fetchAllGroups`): `participants?.length ?? 0`, guarda em
  `groupFetchAllParticipating()` (pode resolver `undefined` logo após reconexão), `if (!group) continue`.

**Perder isso significa:** `500 Cannot convert undefined or null to object` em
`/group/fetchAllGroups`, `/group/findGroup`, `/group/inviteCode` e `/group/participants`. O guard de
rota dispara em **qualquer** cliente que faça GET sem `Content-Type` — o caso comum.

---

## 2. Condicionais — dependem de como usamos

### 2.1 `instanceName` no `/instance/create` — bloqueante para o roadmap
`7185e516` · `abstract.router.ts` + `instance.controller.ts`

O `sanitizeUntrustedInput()` do upstream (introduzido em `7a55a2bf`, correção de auth bypass
cross-instance) remove `instanceName`/`instanceId` de qualquer body. Mas `POST /instance/create` não
tem `:instanceName` na URL — o nome **só pode** vir do body. O filtro de segurança removia o dado
necessário. Nosso fix parametriza os campos protegidos e, nessa rota, protege **apenas** `instanceId`.

**Hoje não bloqueia:** o Help.ia não chama `/instance/create` (verificado — sem ocorrências em
`src-help-ia-backend/` e `scripts/`).

**Mas bloqueia o roadmap:** o item FB-15 do backlog ("Provisionador Interno da Evolution API no
Help.IA", criar instância e exibir QR no painel) depende exatamente dessa rota.

O afrouxamento é cirúrgico e **não** reabre o bypass do `7a55a2bf`.

### 2.2 Batching concorrente de `profilePicture`
`6c4c2fcb` · `fetchAllGroups`

Troca o loop sequencial por lotes de 5 em paralelo, timeout de 8s por foto, `try/catch` por grupo e
pausa de 300ms entre lotes.

**Perder isso significa:** com muitos grupos, a rajada sequencial de `profilePicture` provoca
**rate-overlimit** do WhatsApp e a rota pode levar minutos ou estourar o timeout do cliente.

**Nota:** está no mesmo bloco de código do item 1.4 (serviço) — os dois commits são cumulativos.
**Não dá para pegar um sem o outro.**

### 2.3 `fetchInstances` com filtro por query — não bloqueia hoje
`c5302391`

Mesma raiz do 2.1, na query string: `GET /instance/fetchInstances?instanceName=X` tinha o filtro
removido silenciosamente, retornando **todas** as instâncias em vez da pedida.

**Não bloqueia:** o único consumidor é `help-ia-backend/scripts/provision-evolution.ts:77`, que chama
`/instance/fetchInstances` **sem filtro** e filtra do lado dele.

**Fica como armadilha:** se alguém um dia adicionar `?instanceName=`, a falha é **silenciosa** —
resultado errado, não erro. É o item mais traiçoeiro da lista.

### 2.4 Ponte `DATABASE_URL` → `DATABASE_CONNECTION_URI`
`prisma.config.ts`, `src/config/env.config.ts`, `runWithProvider.js`

O Railway provisiona a variável como `DATABASE_URL`; a Evolution usa `DATABASE_CONNECTION_URI`.

**Mitigação trivial:** definir `DATABASE_CONNECTION_URI = ${{Postgres.DATABASE_URL}}` no serviço
Railway. Rebaixa de bloqueante para "uma variável a mais".

---

## 3. Dispensáveis

| Item | Commit | Por quê |
|---|---|---|
| Campo legado `name` na criação de instância | `d0d983ac` | Shim de compatibilidade para Manager UI antigo. Basta enviar `instanceName`. |
| Dockerfile adaptado ao Railway | `a8ab789d`..`727f5b54` | Usando imagem pré-buildada, ele não roda. Vira trabalho de configuração do serviço, não perda de função. Bônus: elimina o hardcode `DATABASE_PROVIDER=postgresql`, que hoje impede MySQL. |
| Robustez de `SERVER_TYPE` / fallback HTTP | `src/main.ts`, `env.config.ts` | Hardening. Risco baixo com `SERVER_TYPE=http` bem escrito. |
| `EVOHUB` em `monitor.service.ts:300` | `f7429979` | **Não é nosso** — é commit do upstream `develop`. Só se perde no Cenário A. |
| `patches/` (patch-package) | — | **Nenhum patch ativo.** O antigo (`baileys+7.0.0-rc.6.patch`, waveform de PTT) foi incorporado no rc13. |
| Dependências | — | `git diff upstream/develop..HEAD -- package.json` é **vazio**. O fork não alterou nenhuma. |

---

## 4. A recomendação

**Sete dos oito itens de código são correções de bugs genuínos do upstream, não preferências nossas.**
O caminho que reduz o custo de manutenção permanentemente é **submeter os fixes upstream**, não
manter o fork indefinidamente.

Ordem sugerida por valor sobre esforço:

1. `68c00647` — reconexão no 408. O mais impactante, e o upstream tem o bug hoje.
2. `224d1aa3` + `bf0dc07a` — guards de grupo. Diff mínimo e óbvio, fácil de aceitar.
3. `c270b721` — proxy agent no rc13.
4. `7185e516` + `c5302391` — sanitização. São **regressões introduzidas pelo próprio upstream** em
   `7a55a2bf`, o que fortalece o argumento.
5. `5049b158` + `3a6a64c9` — já submetido como #2708, aguardando.

Cada PR aceito diminui o delta e aproxima o dia de abandonar o fork.

---

## 5. Conhecimento operacional a preservar

O `RAILWAY-DEPLOY.md` deste repositório contém coisas que **não existem em nenhum outro lugar** e que
custaram sessões de depuração. Se um dia o fork for abandonado, esse arquivo precisa sobreviver:

- **Variáveis renomeadas silenciosamente:** `DATABASE_SAVE_MESSAGES` e `STORE_MESSAGES` **não existem
  mais**; o nome correto é `DATABASE_SAVE_DATA_NEW_MESSAGE`. Copiar variáveis de um ambiente RC antigo
  sem revisar faz a Evolution **parar de gravar na tabela `Message` sem erro nenhum** — foi o que
  quebrou a edição de mensagem no Help.ia, que lê `messageSecret` direto do Postgres da Evolution.
- **QR não carrega** (`TypeError: Cannot read properties of undefined (reading 'state')`): falta
  `DATABASE_SAVE_DATA_INSTANCE=true` e/ou `CACHE_REDIS_SAVE_INSTANCES=true`.
- Conclusão da própria equipe, que vale como regra: *"A maior parte dos problemas ao subir esta versão
  mais nova não foram bugs de código, e sim variáveis de ambiente renomeadas ou omitidas."*

---

## 6. Limpeza pendente (independente da decisão)

`makeProxyAgentUndici` em `src/utils/makeProxyAgent.ts` ficou **sem nenhum consumidor** depois do
`c270b721` — ~50 linhas de código morto arrastando a dependência conceitual do Undici.
