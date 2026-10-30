# Beti Bachao server — zero runtime dependencies.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8080 DATA_FILE=/data/db.json COOKIE_SECURE=true MFA_REQUIRED=true
VOLUME /data
EXPOSE 8080
USER node
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/api/v1/health || exit 1
CMD ["node", "server/server.js"]
