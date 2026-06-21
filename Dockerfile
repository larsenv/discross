FROM node:lts

# Skip downloading chromium for any dependencies, set env
ENV NODE_ENV=production

WORKDIR /usr/src/app

# Copy dependency configuration
COPY package.json .
COPY package-lock.json* ./
COPY tsconfig.json .

# Install dependencies (must not omit dev so tsx and typescript are installed for npm start)
RUN npm install && npm cache clean --force

# Copy source code
COPY index.ts .
COPY src src
COPY pages pages
# Copy secrets if they exist (will ignore if not copied gracefully with a glob or just rely on dockerignore)
COPY secrets* secrets/

USER node

EXPOSE 4000

CMD ["npm", "start"]
