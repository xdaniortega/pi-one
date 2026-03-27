FROM node:22-slim

RUN groupadd -r ows && useradd -r -g ows -m -d /home/ows ows

WORKDIR /app
COPY kms/package.json kms/package-lock.json* ./
RUN npm install --production

COPY kms/src/ ./src/

# Create vault, socket, and secrets directories
# The secrets dir is a volume mount point -- Docker initializes the volume
# with these permissions on first use, so the ows user can write tokens.
RUN mkdir -p /home/ows/.ows /var/run/ows /run/secrets/pi-agent && \
    chown -R ows:ows /home/ows/.ows /var/run/ows /run/secrets/pi-agent

USER ows

ENV OWS_VAULT_PATH=/home/ows/.ows
ENV OWS_WALLET_NAME=pi-treasury
ENV OWS_PASSPHRASE_FILE=/home/ows/.ows/passphrase
ENV KMS_SOCKET_PATH=/var/run/ows/ows.sock

HEALTHCHECK --interval=5s --timeout=3s --retries=3 \
  CMD node -e "const http=require('http');const req=http.request({socketPath:'/var/run/ows/ows.sock',path:'/health'},res=>{process.exit(res.statusCode===200?0:1)});req.on('error',()=>process.exit(1));req.end()"

CMD ["node", "src/server.js"]
