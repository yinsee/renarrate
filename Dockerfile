FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    ca-certificates \
    build-essential \
    cmake \
    git \
    && rm -rf /var/lib/apt/lists/*

# Build whisper.cpp from source. Produces /usr/local/bin/whisper-cli.
# The GGML model file (ggml-medium.bin, auto-downloaded on first run) is NOT baked into the image — it is
# bind-mounted from the host via docker-compose (see volumes). This keeps the
# image small and lets the host manage which whisper model is in use.
ARG TARGETARCH
RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp && \
    cd /tmp/whisper.cpp && \
    if [ "$TARGETARCH" = "arm64" ]; then \
      cmake -B build -DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8.2-a+fp16+dotprod -DCMAKE_BUILD_TYPE=Release; \
    else \
      cmake -B build -DGGML_NATIVE=ON -DCMAKE_BUILD_TYPE=Release; \
    fi && \
    cmake --build build --config Release -j && \
    install -m 0755 build/bin/whisper-cli /usr/local/bin/whisper-cli && \
    rm -rf /tmp/whisper.cpp

# PyTorch f5-tts for TTS on Linux (f5-tts-mlx is Mac-only and won't install here).
RUN pip install --break-system-packages --no-cache-dir f5-tts

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PYTHON_BIN=/usr/bin/python3
ENV LLM_URL=http://ollama:11434/v1
ENV LLM_MODEL=gemma3:4b
ENV WHISPER_CPP_MODEL_DIR=/app/models/whisper-cpp
ENV PORT=8080

EXPOSE 8080

CMD ["node", "lib/server.js"]
