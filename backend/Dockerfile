FROM node:18-alpine

WORKDIR /app

# Install OpenSSL so we can generate x509 certificates signed by the CA
RUN apk add --no-cache openssl

COPY package*.json ./

RUN npm ci --only=production

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
