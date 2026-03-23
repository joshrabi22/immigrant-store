##############################################
# Stage 1 — build the React client
##############################################
FROM node:20-slim AS builder

WORKDIR /app

# Install client dependencies (including devDeps for Vite)
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci

# Build the client
COPY client/ ./client/
RUN cd client && npx vite build

##############################################
# Stage 2 — production runtime
##############################################
FROM node:20-slim

# Install dependencies for Playwright Chromium
RUN apt-get update && apt-get install -y \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
    libasound2 libxshmfence1 fonts-noto-color-emoji \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Install Playwright Chromium
RUN npx playwright install chromium

# Copy source
COPY . .

# Copy built client from builder stage
COPY --from=builder /app/client/dist ./client/dist

# Create image directories
RUN mkdir -p images/orders images/candidates images/processed

EXPOSE 3000

# Default: run the web server. Override with alistream.js for the worker.
CMD ["node", "server.js"]
