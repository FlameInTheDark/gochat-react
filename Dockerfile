# syntax=docker/dockerfile:1

# Build stage
FROM oven/bun:1-alpine AS build
WORKDIR /app

ARG VITE_API_BASE_URL=""
ARG VITE_WEBSOCKET_URL=""
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_WEBSOCKET_URL=${VITE_WEBSOCKET_URL}

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Production stage
FROM nginx:alpine AS production
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
