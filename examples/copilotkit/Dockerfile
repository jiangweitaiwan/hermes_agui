FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY frontend/ frontend/
COPY vite.config.ts ./
RUN npx vite build
COPY server/ server/
COPY tsconfig.json ./
RUN npx tsc --noEmit
ENV HOME=/tmp/node-home
USER 10000:10000
EXPOSE 3000
CMD ["npm", "start"]
