FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

ENV NODE_ENV=production
WORKDIR /app

COPY sims/vendor-simulator/package.json ./package.json
COPY sims/vendor-simulator/dist ./dist

EXPOSE 9090
CMD ["node", "dist/server.js"]
