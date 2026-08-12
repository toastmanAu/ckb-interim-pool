FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY db ./db
COPY schemas ./schemas
ENV POOL_API_PORT=8080
EXPOSE 8080
CMD ["node", "src/api/api-server.js"]
