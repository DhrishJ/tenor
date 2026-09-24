# Attestation service image (OBJECTIONS P4-O2, P4-O12). Build from the repo
# root, since the service reads deployments/<CHAIN_ID>.json:
#   docker build -f packages/attestor/Dockerfile -t tenor-attestor .
# All configuration comes from the environment (see .env.example); no secret
# is baked into the image.
FROM node:24.21.0-slim
WORKDIR /app/packages/attestor
COPY packages/attestor/package.json packages/attestor/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY packages/attestor/src ./src
COPY packages/attestor/tsconfig.json ./
COPY deployments /app/deployments
ENV NODE_ENV=production
USER node
EXPOSE 8787
CMD ["node_modules/.bin/tsx", "src/server.ts"]
