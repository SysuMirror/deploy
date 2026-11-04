# 仅用官方 Python 镜像 + 国内 PyPI 预编译 wheel，不再 apt 装编译器
FROM python:3.12-slim

WORKDIR /app

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8002 \
    DB_PATH=/data/novelwriter.db \
    UPLOAD_DIR=/data/uploads

COPY requirements.txt .

# 清华 PyPI；优先二进制轮子，避免现场编译 cryptography/bcrypt
RUN pip install -i https://pypi.tuna.tsinghua.edu.cn/simple \
    --trusted-host pypi.tuna.tsinghua.edu.cn \
    --prefer-binary \
    -r requirements.txt

COPY . .

RUN mkdir -p /data/uploads/covers /data/uploads/knowledge

EXPOSE 8002
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8002}"]
