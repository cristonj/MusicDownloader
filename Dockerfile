# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --strict-ssl=true
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/.next/standalone ./
RUN useradd --create-home music && chmod -R a+rX /app
USER music
ENV PORT=8080 HOSTNAME=0.0.0.0 NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
