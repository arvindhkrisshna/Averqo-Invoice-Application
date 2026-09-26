# Averqo production image: builds the website and the Go server, then runs
# both as one small program on port 8080.
#   docker compose -f docker-compose.prod.yml up -d --build

# 1. Website
FROM node:24-alpine AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npx ng build --configuration production

# 2. Server
FROM golang:1.24-alpine AS api
WORKDIR /src/backend
COPY backend/ ./
RUN go mod tidy && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /averqo .

# 3. Runtime
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata && adduser -D -H averqo
WORKDIR /app
COPY --from=api /averqo ./averqo
COPY --from=web /src/frontend/dist/frontend/browser ./public
USER averqo
ENV PORT=8080 STATIC_DIR=/app/public
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["./averqo"]
