FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY index.js ./
EXPOSE 4000
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs
CMD ["node", "index.js"]
