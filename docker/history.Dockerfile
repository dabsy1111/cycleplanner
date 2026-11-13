FROM python:3.12-alpine
COPY history/*.py /app/
ENV DATA_DIR=/data PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8000
CMD ["python", "/app/server.py"]
