FROM python:3.12-alpine
COPY history/server.py /app/server.py
ENV DATA_DIR=/data PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8000
CMD ["python", "/app/server.py"]
