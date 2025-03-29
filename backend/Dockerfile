# 使用 golang:1.20 作为基础镜像
FROM golang:alpine

# 设置工作目录
WORKDIR /app

# 将当前代码复制到容器中的 /app 目录
COPY . .

# 构建应用程序
RUN go build -o main .

# 设置容器启动命令
CMD ["./main"]