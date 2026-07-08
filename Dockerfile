FROM node:24-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-slim AS production

# Librerias de sistema que Chromium headless necesita para generar los PDF
RUN apt-get update && apt-get install -y --no-install-recommends     ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0     libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1     libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1     libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2     && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server

EXPOSE 3000

CMD ["npm", "run", "start"]
