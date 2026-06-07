FROM node:lts-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the source
COPY . .

# Build the project
RUN npm run build

# Hugging Face Spaces requires the app to listen on 0.0.0.0:7860
ENV HOST=0.0.0.0
ENV PORT=7860

EXPOSE 7860

CMD ["npm", "start"]
