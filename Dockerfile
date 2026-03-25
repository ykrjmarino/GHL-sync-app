FROM node:20-alpine

WORKDIR /app

# Copy only package files first to leverage caching
COPY package*.json ./

RUN npm install --production

# Copy rest of the backend code
COPY . .

# Expose Cloud Run port
EXPOSE 8080

# Start the server
CMD ["node", "server.js"]