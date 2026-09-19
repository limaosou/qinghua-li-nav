FROM node:20-slim
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
