FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
ENV DB_PATH=/app/data/bench.db PORT=3000
VOLUME /app/data
EXPOSE 3000
CMD ["node", "server.js"]
