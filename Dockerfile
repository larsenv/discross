FROM node:lts

ENV NODE_ENV production

WORKDIR /usr/src/app

COPY bot.js .
COPY authentication.js .
COPY connectionHandler.js .
COPY index.js .
COPY package.json .
COPY pages pages
COPY secrets secrets

RUN npm install --production --omit=dev && npm cache clean --force

USER node

EXPOSE 4000

CMD node index.js