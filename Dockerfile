FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY circuits ./circuits
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server.js"]
