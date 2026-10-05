FROM node:22-alpine

WORKDIR /app

# Copy package files if they exist
COPY package*.json ./
RUN npm ci --only=production 2>/dev/null || true

# Copy proxy code
COPY *.js *.html ./

# Data directory (mounted as volume)
ENV LATERAL_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 3005

CMD ["node", "server.js"]
