# VideoGrab — Extensão de Captura e Download de Mídia (Manifest V3)

**VideoGrab** é uma extensão de navegador construída no padrão **Manifest V3**, com arquitetura modular e processamento local via **WebAssembly (FFmpeg / LibAV + OPFS)**, sem limites de tempo, sem bloqueios de plataforma e sem paywalls.

---

## Principais Recursos

- **Captura Multi-Protocolo**:
  - **HLS (`.m3u8`)**: Analisa Master Playlists (`#EXT-X-STREAM-INF`) e Media Playlists, listando todas as resoluções e unindo faixas de vídeo e áudio separadas.
  - **DASH (`.mpd`)**: Processamento de manifestos MPEG-DASH.
  - **HTTP Direto**: MP4, WebM, MKV, FLV, MOV, MP3, M4A, AAC, OGG, WAV.
  - **Extratores de Plataformas**: Suporte integrado a YouTube (incluindo 1080p/4K com remuxing de vídeo+áudio separados e decifragem em Sandbox), Vimeo, Facebook, Instagram, Bilibili, VK, OK.ru, Kick, Canva e mais.
- **Processamento FFmpeg / LibAV em WebAssembly**:
  - Junta streams de vídeo e áudio independentes em `.mp4` ou `.mkv`.
  - Extrai e converte faixas de áudio diretamente para `.mp3`.
  - Gravação de alta velocidade no disco via **OPFS (Origin Private File System)** (`createSyncAccessHandle`), evitando alto consumo de memória RAM.
- **Zero Limitações**:
  - Sem cooldown de 2 horas entre downloads.
  - Sem bloqueio de YouTube em navegadores baseados em Chromium (Chrome, Edge, Brave, Vivaldi).
  - Sem restrição de ID de extensão (`runtime.id`) ou telemetria externa.

---

## Estrutura de Arquivos

```text
video_grab/
├── manifest.json                 # Manifesto MV3 da extensão VideoGrab
├── icons/                        # Ícones PNG (16x16, 48x48, 128x128)
├── service/
│   ├── main.js                   # Service Worker principal (gerenciamento de estado, abas e mensagens)
│   ├── serde.js                  # Serializador/Deserializador e tipos funcionais (Option/Result)
│   ├── sniffer.js                # Interceptador de rede HTTP / HLS (.m3u8) / DASH (.mpd)
│   ├── dnr_headers.js            # Injeção dinâmica de cabeçalhos via declarativeNetRequest
│   ├── downloader.js             # Orquestrador do Offscreen + Download Worker + OPFS + chrome.downloads
│   └── emscripten-module.wasm    # Binário WASM auxiliar
├── factory/
│   ├── factory.html              # Documento Offscreen (chrome.offscreen)
│   ├── factory.js                # Inicializador do Worker de download e ponte Sandbox
│   └── sandbox.html              # Sandbox isolado para avaliação segura de scripts decipher
├── download_worker/
│   ├── main.js                   # Worker de download e muxing (16 estratégias)
│   ├── libav-6.5.7.1-h264-aac-mp3.wasm.mjs
│   └── libav-6.5.7.1-h264-aac-mp3.wasm.wasm
├── injected/
│   ├── media_detector.js         # Detector universal de elementos <video>/<audio> e metadados da página
│   └── *.js                      # Extratores dedicados por plataforma (YouTube, Vimeo, FB, etc.)
└── ui/
    ├── popup.html                # Interface Popup
    ├── sidebar.html              # Interface Painel Lateral (Chrome Side Panel)
    ├── styles.css                # Estilos modernos (Dark/Light mode automático)
    └── app.js                    # Lógica da interface do usuário
```

---

## Como Instalar no Navegador (Chrome / Edge / Brave)

1. Abra o navegador e acesse `chrome://extensions/` (ou `edge://extensions/`, `brave://extensions/`).
2. No canto superior direito, ative a chave **Modo do desenvolvedor** (*Developer mode*).
3. Clique no botão **Carregar sem compactação** (*Load unpacked*).
4. Selecione a pasta raiz deste repositório (`video_grab`).
5. Fixe o ícone do **VideoGrab** na barra de ferramentas do navegador.
