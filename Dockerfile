FROM node:20-slim

# Install dependencies for Playwright Chromium
RUN apt-get update && apt-get install -y \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
    libasound2 libxshmfence1 fonts-noto-color-emoji \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install root dependencies
COPY package.json package-lock.json ./
RUN npm ci --production

# Install Playwright Chromium
RUN npx playwright install chromium

# Install client dependencies and build
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci --production
COPY client/ ./client/
RUN cd client && npx vite build

# Copy source
COPY . .

# Create image directories
RUN mkdir -p images/orders images/candidates images/processed

EXPOSE 3000

# Default: run the web server. Override with alistream.js for the worker.
CMD ["node", "server.js"]
