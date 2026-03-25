FROM node:20-alpine

WORKDIR /app

# Copy package files from backend
COPY backend/package*.json ./

RUN npm install --production

# Copy rest of the backend code
COPY backend/. ./

# Expose Cloud Run port
EXPOSE 8080

# Start the server
CMD ["node", "server.js"]