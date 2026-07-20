# syntax=docker/dockerfile:1

# ---- build the static demo site (needs devDependencies: vite + three) ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# --include=dev so the build still gets vite/three even if NODE_ENV=production is set.
RUN npm ci --include=dev
COPY . .
# Builds the DEMO (index.html + gallery/) into /app/dist-demo — NOT the library (dist/).
RUN npm run build:demo

# ---- serve the static files with nginx ----
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist-demo /usr/share/nginx/html
EXPOSE 80
