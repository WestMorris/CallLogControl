FROM python:3.13-alpine
WORKDIR /app
RUN addgroup -g 10001 calllog && adduser -D -u 10001 -G calllog calllog \
    && mkdir /data && chown calllog:calllog /data
COPY server.py qrcodegen.py analytics.py /app/
COPY web /app/web
USER calllog
ENV CALLLOG_DATA_DIR=/data PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "server.py", "serve", "--host", "0.0.0.0"]
