FROM node:22-slim

WORKDIR /app

# Install pi-coding-agent
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy wallet skill where Pi auto-discovers it
COPY skills/wallet/ ./.agents/skills/wallet/

# Copy bootstrap script
COPY scripts/bootstrap-token.js ./scripts/bootstrap-token.js

# Create working directories owned by node user (uid 1000)
RUN mkdir -p /work /tmp/agent /data/.pi/agent/sessions && \
    chown -R node:node /work /tmp/agent /app /data

USER node

ENV KMS_SOCKET_PATH=/var/run/ows/ows.sock
ENV OWS_TOKEN_FILE=/data/token
ENV OWS_APPROVED_TOKENS_FILE=/data/approved-tokens.json
ENV WALLET_SCRIPT=/app/.agents/skills/wallet/scripts/wallet.js
ENV HOME=/data

# Bootstrap token (waits for approval if needed), then start Pi
# Pi auto-discovers skills from .agents/skills/
CMD ["sh", "-c", "node scripts/bootstrap-token.js && npx pi"]
