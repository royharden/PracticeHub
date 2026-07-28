FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

ENV NODE_ENV=production
WORKDIR /app

COPY sims/vendor-simulator/package.json ./package.json
COPY sims/vendor-simulator/dist ./dist

# WP-027: the service resolves its workspace packages as plain bare specifiers,
# so their built output is placed where Node looks for them. No install runs in
# the image — these packages carry no external dependencies, only each other.
COPY sims/vendor-sim-kit/package.json ./node_modules/@practicehub/vendor-sim-kit/package.json
COPY sims/vendor-sim-kit/dist ./node_modules/@practicehub/vendor-sim-kit/dist
COPY packages/contracts/package.json ./node_modules/@practicehub/contracts/package.json
COPY packages/contracts/dist ./node_modules/@practicehub/contracts/dist
COPY packages/platform/package.json ./node_modules/@practicehub/platform/package.json
COPY packages/platform/dist ./node_modules/@practicehub/platform/dist
COPY modules/platform-core/package.json ./node_modules/@practicehub/platform-core/package.json
COPY modules/platform-core/dist ./node_modules/@practicehub/platform-core/dist
COPY modules/platform-integration/package.json ./node_modules/@practicehub/platform-integration/package.json
COPY modules/platform-integration/dist ./node_modules/@practicehub/platform-integration/dist

EXPOSE 9090
CMD ["node", "dist/server.js"]
