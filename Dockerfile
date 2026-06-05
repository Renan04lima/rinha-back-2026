# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — build: run the preprocessor once, baking the IVF index into the
# image. This is where the ~1.3 GB / ~2.9 s cost of parsing references.json.gz
# is paid — at build time, never at runtime. The output is the three compact
# .bin files (~45 MB total).
# ---------------------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

# preprocess.js uses only Node built-ins, but we install deps here anyway so the
# layer is cached identically to runtime.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The gz lives in resources/; bring in the sources needed to generate the index.
COPY scripts ./scripts
COPY resources/references.json.gz ./resources/references.json.gz
RUN node scripts/preprocess.js

# ---------------------------------------------------------------------------
# Stage 2 — runtime: a slim image that carries only the server, the generated
# binaries, and the small JSON resources. The 50 MB gz is left behind.
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts/ivf-core.js ./scripts/ivf-core.js

# Small resources needed at runtime (vectorize + naive fallback import).
COPY resources/normalization.json resources/mcc_risk.json resources/example-references.json ./resources/
# The generated index.
COPY --from=build /app/resources/vectors.bin /app/resources/labels.bin /app/resources/ivf.bin ./resources/

EXPOSE 9999
CMD ["node", "src/index.js"]
