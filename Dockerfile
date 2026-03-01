# waoowaoo Dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci && npm cache clean --force

# Copy source
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build Next.js app
RUN npm run build

# Expose ports (app + bull board)
EXPOSE 3000 3010

# Start all services
CMD ["npm", "run", "start"]
