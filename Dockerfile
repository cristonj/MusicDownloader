# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --strict-ssl=true
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_RESOLVER_URL=auto
RUN npm run build

FROM python:3.12-slim-bookworm
WORKDIR /app
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY resolver/requirements.txt ./requirements.txt
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export PIP_CERT=/run/secrets/proxy_ca; fi; \
    pip install --no-cache-dir -r requirements.txt
COPY --from=frontend /usr/local/bin/node /usr/local/bin/node
COPY --from=frontend /app/out /app/public
COPY resolver/app.py resolver/worker.py ./
RUN useradd --create-home music && chmod -R a+rX /app
USER music
ENV STATIC_DIRECTORY=/app/public
EXPOSE 8080
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080} --no-access-log"]
