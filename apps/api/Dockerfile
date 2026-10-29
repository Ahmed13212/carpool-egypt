# NOTE: authored but NOT built or run in the authoring sandbox (no Docker available). Verify before relying on it.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci
COPY apps/api apps/api
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev
COPY --from=build /app/apps/api/dist apps/api/dist
COPY database database
USER node
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "dist/main.js"]
