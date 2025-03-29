# Stream Backend

A simple backend with golang.

## Running locally

```bash
go mod tidy # go mod download
go run main.go
```

## Running with Docker

```bash
docker build . -t stream-backend:0.0.x
# modify docker-compose.yaml
docker compose up -d
```
