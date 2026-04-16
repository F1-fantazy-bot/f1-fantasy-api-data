FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /usr/src/app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts

# Install only Chromium (skip other browsers)
RUN npx playwright install chromium

# Copy application source
COPY index.js ./
COPY src ./src

# Run as non-root user (pwuser is built into the Playwright image)
USER pwuser

CMD ["node", "index.js"]
