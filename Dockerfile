FROM node:18-alpine

WORKDIR /app

# Install Python and build dependencies
RUN apk add --no-cache python3 make g++ gcc

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Instead of using npm set-script, modify package.json directly
COPY package.json .
RUN npm pkg set scripts.test="jest --detectOpenHandles --forceExit"
RUN npm pkg set scripts.build="tsc --noEmit"

# Build and test
RUN npm run build && npm test

# Expose port
EXPOSE 3000

# Start the application
CMD ["npm", "start"] 