FROM node:24-alpine AS builder

RUN apk update && \
    apk add --no-cache git ffmpeg wget curl bash openssl

LABEL version="2.3.1" description="Api to control whatsapp features through http requests." 
LABEL maintainer="Davidson Gomes" git="https://github.com/DavidsonGomes"
LABEL contact="contato@evolution-api.com"

WORKDIR /evolution

COPY ./package*.json ./
COPY ./tsconfig.json ./
COPY ./tsup.config.ts ./
COPY ./prisma.config.ts ./
COPY ./patches ./patches

RUN npm ci --silent
RUN npx patch-package

COPY ./src ./src
COPY ./public ./public
COPY ./prisma ./prisma
COPY ./manager ./manager
COPY ./runWithProvider.js ./
COPY ./Docker ./Docker

ENV DATABASE_PROVIDER=postgresql

# 1. Copia o schema diretamente
RUN cp -r ./prisma/postgresql-migrations ./prisma/migrations && cp ./prisma/postgresql-schema.prisma ./prisma/schema.prisma

# 2. Roda a geracao dos tipos Prisma explicitando o schema seguro (bypassa o dotenvx)
RUN DATABASE_CONNECTION_URI=postgresql://build:build@localhost:5432/build npx prisma generate --schema ./prisma/schema.prisma

ARG LICENSE_ENDPOINT_ENCODED
ARG LICENSE_ENDPOINT_XOR_KEY
ENV LICENSE_ENDPOINT_ENCODED=${LICENSE_ENDPOINT_ENCODED}
ENV LICENSE_ENDPOINT_XOR_KEY=${LICENSE_ENDPOINT_XOR_KEY}

RUN NODE_OPTIONS="--max-old-space-size=2048" npm run build

FROM node:24-alpine AS final

RUN apk update && \
    apk add tzdata ffmpeg bash openssl

ENV TZ=America/Sao_Paulo
ENV DOCKER_ENV=true
ENV SERVER_TYPE=http
ENV SERVER_PORT=8080

WORKDIR /evolution

COPY --from=builder /evolution/package.json ./package.json
COPY --from=builder /evolution/package-lock.json ./package-lock.json
COPY --from=builder /evolution/prisma.config.ts ./prisma.config.ts
COPY --from=builder /evolution/node_modules ./node_modules
COPY --from=builder /evolution/dist ./dist
COPY --from=builder /evolution/prisma ./prisma
COPY --from=builder /evolution/manager ./manager
COPY --from=builder /evolution/public ./public
COPY --from=builder /evolution/Docker ./Docker
COPY --from=builder /evolution/runWithProvider.js ./runWithProvider.js
COPY --from=builder /evolution/tsup.config.ts ./tsup.config.ts

ENV DOCKER_ENV=true

EXPOSE 8080

# 3. Executa as migrations com a URL fornecida pelo ambiente e inicia a API.
CMD ["sh", "-c", "npx prisma migrate deploy --config ./prisma.config.ts && npm run start:prod"]