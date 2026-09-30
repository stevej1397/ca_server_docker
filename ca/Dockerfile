FROM golang:1.21-alpine AS builder

RUN apk add --no-cache git make

WORKDIR /tmp
RUN git clone https://github.com/smallstep/certificates.git && \
    cd certificates && \
    git checkout v0.24.2 && \
    make bin/step-ca

RUN git clone https://github.com/smallstep/cli.git && \
    cd cli && \
    git checkout v0.24.2 && \
    make bin/step

FROM alpine:3.18

RUN apk add --no-cache curl bash ca-certificates openssl

# Copy step-ca binary from builder
COPY --from=builder /tmp/certificates/bin/step-ca /usr/local/bin/
COPY --from=builder /tmp/cli/bin/step /usr/local/bin/

# Create step user
RUN addgroup step && adduser -D -G step step

WORKDIR /home/step
RUN mkdir -p /home/step/certs && chown -R step:step /home/step

USER step

# Expose CA and API ports
EXPOSE 9000

# Initialize CA and start it
CMD ["/tmp/init-ca.sh"]
COPY init-ca.sh /tmp/
USER root
RUN chmod +x /tmp/init-ca.sh

USER step

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD step ca health || exit 1

CMD ["/tmp/init-ca.sh"]
