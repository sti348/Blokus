# Northflank: one container serves both the website and multiplayer SSE API.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app
COPY --chown=node:node package.json server.js index.html ./
COPY --chown=node:node js/ ./js/
COPY --chown=node:node css/ ./css/

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/info').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "server.js"]
