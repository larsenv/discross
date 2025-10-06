FROM node:lts

ENV NODE_ENV production

WORKDIR /usr/src/app

RUN --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

USER node

COPY bot.js .
COPY authentication.js .
COPY connectionHandler.js .
COPY index.js .
COPY package.json .
COPY pages pages
COPY secrets secrets

EXPOSE 4000

CMD npm start