FROM node:22-alpine
WORKDIR /app
COPY package.json server.js core.js ./
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_PATH=/data/kanban.db
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
