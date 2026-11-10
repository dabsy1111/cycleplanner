FROM alpine:3.20 AS fetch
ARG BROUTER_VERSION=1.7.9
RUN apk add --no-cache curl unzip \
 && curl -fsSL -o /tmp/brouter.zip \
      "https://github.com/abrensch/brouter/releases/download/v${BROUTER_VERSION}/brouter-${BROUTER_VERSION}.zip" \
 && unzip -q /tmp/brouter.zip -d /tmp \
 && mkdir -p /opt/brouter \
 && mv "/tmp/brouter-${BROUTER_VERSION}/brouter-${BROUTER_VERSION}-all.jar" /opt/brouter/brouter.jar \
 && mv "/tmp/brouter-${BROUTER_VERSION}/profiles2" /opt/brouter/profiles-default

FROM eclipse-temurin:21-jre
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /opt/brouter /opt/brouter
COPY docker/brouter-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV TILES="E115_S35" \
    REFRESH_DAYS=7 \
    JAVA_MAX_HEAP=1g \
    MAX_THREADS=4
VOLUME /data
EXPOSE 17777
ENTRYPOINT ["/entrypoint.sh"]
