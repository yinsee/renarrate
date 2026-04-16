FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --break-system-packages --no-cache-dir openai-whisper f5-tts

RUN mkdir -p /root/.cache/whisper && \
    curl -fsSL -o /root/.cache/whisper/small.en.pt \
    https://openaipublic.azureedge.net/main/whisper/models/9ecf779972d90ba49c06d968637d720dd632c55bbf19c977e8db3158651c2cda/small.en.pt

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PYTHON_BIN=/usr/bin/python3
ENV LLM_URL=http://ollama:11434/v1
ENV LLM_MODEL=gemma3:4b
ENV WHISPER_MODEL=small.en
ENV PORT=8080

EXPOSE 8080

CMD ["node", "lib/server.js"]
