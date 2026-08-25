# God's Eye View — Cloud Run image.
#
# The runtime stage keeps devDependencies on purpose: `server/index.js` imports
# `vite.config.js` to reuse its /api/* proxy plugins, and that file imports
# `vite` and `vite-plugin-cesium`. Pruning to production deps would break every
# proxy at boot.

FROM node:24-slim AS build
WORKDIR /app

# Chromium is only needed by the puppeteer-driven QA scripts, never at runtime.
ENV PUPPETEER_SKIP_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# GOOGLE_MAPS_API_KEY and CESIUM_ION_TOKEN are inlined into the browser bundle
# by vite's `define` — they are client-exposed by design (see SECURITY.md) and
# must be present at BUILD time, not run time. Restrict them by HTTP referrer.
ARG GOOGLE_MAPS_API_KEY=""
ARG CESIUM_ION_TOKEN=""
ENV GOOGLE_MAPS_API_KEY=$GOOGLE_MAPS_API_KEY \
    CESIUM_ION_TOKEN=$CESIUM_ION_TOKEN
RUN npm run build


FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/vite.config.js ./vite.config.js
# vite.config.js imports helpers out of src/data/, so src must ship too.
COPY --from=build /app/src ./src
COPY --from=build /app/server ./server

EXPOSE 8080
USER node
CMD ["node", "server/index.js"]
