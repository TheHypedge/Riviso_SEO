FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG BACKEND_URL=http://backend:8000
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV BACKEND_URL=${BACKEND_URL}
RUN npm run build

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "run", "start"]
