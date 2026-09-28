# Built from the REPO ROOT (context .), by .github/workflows/addon-image.yml or `just image`:
#   docker build -f haos/addon/Dockerfile --build-arg BUILD_ARCH=amd64 .
# The stock PocketBase release binary (sha256-pinned) + our JS migrations, JS hooks and the built
# UI. No Go, no Node: frontend/dist is committed. The download happens on the build host; the final
# stage only copies files, so no emulation is needed for aarch64.
ARG BUILD_ARCH=amd64
ARG PB_VERSION=0.40.4

FROM --platform=$BUILDPLATFORM alpine:3.22 AS pocketbase
ARG BUILD_ARCH
ARG PB_VERSION
RUN apk add --no-cache curl unzip \
 && case "${BUILD_ARCH}" in \
      amd64)   PB_ARCH=amd64; PB_SHA256=9042ec818570e79c3628dadcd0a756c1496d9e1173918ec409d133c02f82e5fa ;; \
      aarch64) PB_ARCH=arm64; PB_SHA256=86095bf8ed9345954f0d2bf0a5fb9b57584ae60b77ebf3b6cd23a8003a3fd418 ;; \
      *) echo "unsupported arch: ${BUILD_ARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${PB_ARCH}.zip" -o /tmp/pb.zip \
 && echo "${PB_SHA256}  /tmp/pb.zip" | sha256sum -c - \
 && unzip -q /tmp/pb.zip pocketbase -d /out

FROM ghcr.io/home-assistant/${BUILD_ARCH}-base:3.22
ARG BUILD_ARCH
ARG BUILD_VERSION=dev
LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="addon" \
    io.hass.arch="${BUILD_ARCH}" \
    org.opencontainers.image.source="https://github.com/laris-co/message-relay-v3" \
    org.opencontainers.image.description="message-relay v3 Home Assistant add-on"
COPY --from=pocketbase /out/pocketbase /app/pocketbase
COPY pb_migrations /app/pb_migrations
COPY pb_hooks /app/pb_hooks
COPY frontend/dist /app/public
COPY haos/addon/run.sh /run.sh
CMD ["/run.sh"]
